/**
 * Performance Optimizer
 * Coordinates all performance optimization strategies including caching, memory management,
 * progressive processing, and request batching
 */

import { EditRequest, EditResponse, PerformanceMetrics } from './types';
import { CacheManager, getCacheManager } from './cache-manager';
import { MemoryManager, getMemoryManager } from './memory-manager';
import { ProgressiveProcessor } from './progressive-processor';

export interface OptimizationStrategy {
  name: string;
  priority: number;
  enabled: boolean;
  apply: (request: EditRequest) => Promise<OptimizationResult>;
}

export interface OptimizationResult {
  optimized: boolean;
  strategy: string;
  timeSaved: number;
  memorySaved: number;
  cacheHit?: boolean;
  fallbackUsed?: boolean;
}

export interface BatchRequest {
  id: string;
  request: EditRequest;
  priority: number;
  timestamp: number;
  callback: (response: EditResponse) => void;
}

export interface PerformanceConfig {
  enableCaching: boolean;
  enableBatching: boolean;
  enableProgressive: boolean;
  enableMemoryOptimization: boolean;
  batchTimeout: number; // milliseconds
  maxBatchSize: number;
  performanceTarget: 'speed' | 'memory' | 'balanced';
}

export class PerformanceOptimizer {
  private config: PerformanceConfig;
  private strategies: OptimizationStrategy[] = [];
  private batchQueue: BatchRequest[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private metrics: PerformanceMetrics;
  private cacheManager: CacheManager;
  private memoryManager: MemoryManager;
  private progressiveProcessor: ProgressiveProcessor;

  constructor(config: Partial<PerformanceConfig> = {}) {
    this.config = {
      enableCaching: true,
      enableBatching: true,
      enableProgressive: true,
      enableMemoryOptimization: true,
      batchTimeout: 100, // 100ms
      maxBatchSize: 10,
      performanceTarget: 'balanced',
      ...config
    };

    this.metrics = {
      processingTime: 0,
      memoryUsage: 0,
      apiCalls: 0,
      cacheHits: 0,
      cacheMisses: 0
    };

    this.cacheManager = getCacheManager();
    this.memoryManager = getMemoryManager();
    this.progressiveProcessor = new ProgressiveProcessor();

    this.initializeStrategies();
  }

  /**
   * Optimize a single edit request
   */
  async optimizeRequest(request: EditRequest): Promise<{
    optimizedRequest: EditRequest;
    optimizations: OptimizationResult[];
  }> {
    const startTime = Date.now();
    const optimizations: OptimizationResult[] = [];
    let optimizedRequest = { ...request };

    // Apply optimization strategies in priority order
    for (const strategy of this.strategies) {
      if (!strategy.enabled) continue;

      try {
        const result = await strategy.apply(optimizedRequest);
        optimizations.push(result);

        if (result.optimized) {
          // Strategy may have modified the request
          // In a real implementation, strategies would return modified requests
        }
      } catch (error) {
        console.warn(`Optimization strategy ${strategy.name} failed:`, error);
      }
    }

    // Update metrics
    this.metrics.processingTime += Date.now() - startTime;

    return { optimizedRequest, optimizations };
  }

  /**
   * Process request with batching support
   */
  async processWithBatching(
    request: EditRequest,
    priority: number = 5
  ): Promise<EditResponse> {
    return new Promise((resolve, reject) => {
      const batchRequest: BatchRequest = {
        id: `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        request,
        priority,
        timestamp: Date.now(),
        callback: resolve
      };

      this.batchQueue.push(batchRequest);
      this.batchQueue.sort((a, b) => b.priority - a.priority);

      // Start batch timer if not already running
      if (!this.batchTimer) {
        this.batchTimer = setTimeout(() => {
          this.processBatch();
        }, this.config.batchTimeout);
      }

      // Process immediately if batch is full
      if (this.batchQueue.length >= this.config.maxBatchSize) {
        this.processBatch();
      }
    });
  }

  /**
   * Process accumulated batch
   */
  private async processBatch(): Promise<void> {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    if (this.batchQueue.length === 0) return;

    const batch = this.batchQueue.splice(0, this.config.maxBatchSize);
    
    try {
      // Group similar requests for batch processing
      const groups = this.groupSimilarRequests(batch);
      
      for (const group of groups) {
        await this.processRequestGroup(group);
      }
    } catch (error) {
      console.error('Batch processing failed:', error);
      
      // Fallback: process requests individually
      for (const batchRequest of batch) {
        try {
          const response = await this.processSingleRequest(batchRequest.request);
          batchRequest.callback(response);
        } catch (err) {
          console.error(`Failed to process request ${batchRequest.id}:`, err);
        }
      }
    }
  }

  /**
   * Group similar requests for batch processing
   */
  private groupSimilarRequests(batch: BatchRequest[]): BatchRequest[][] {
    const groups: BatchRequest[][] = [];
    const processed = new Set<string>();

    for (const request of batch) {
      if (processed.has(request.id)) continue;

      const group = [request];
      processed.add(request.id);

      // Find similar requests
      for (const other of batch) {
        if (processed.has(other.id)) continue;
        
        if (this.areRequestsSimilar(request.request, other.request)) {
          group.push(other);
          processed.add(other.id);
        }
      }

      groups.push(group);
    }

    return groups;
  }

  /**
   * Check if two requests are similar enough to batch together
   */
  private areRequestsSimilar(req1: EditRequest, req2: EditRequest): boolean {
    // Same provider preference
    if (req1.provider !== req2.provider) return false;

    // Similar global options
    if (req1.globalOptions.qualityLevel !== req2.globalOptions.qualityLevel) return false;
    if (req1.globalOptions.highFidelity !== req2.globalOptions.highFidelity) return false;

    // Similar number of regions
    if (Math.abs(req1.regions.length - req2.regions.length) > 2) return false;

    return true;
  }

  /**
   * Process a group of similar requests
   */
  private async processRequestGroup(group: BatchRequest[]): Promise<void> {
    if (group.length === 1) {
      const response = await this.processSingleRequest(group[0].request);
      group[0].callback(response);
      return;
    }

    // Batch processing logic would go here
    // For now, process individually
    for (const batchRequest of group) {
      const response = await this.processSingleRequest(batchRequest.request);
      batchRequest.callback(response);
    }
  }

  /**
   * Process a single request with all optimizations
   */
  private async processSingleRequest(request: EditRequest): Promise<EditResponse> {
    const startTime = Date.now();

    try {
      // Check cache first
      if (this.config.enableCaching) {
        const cacheKey = CacheManager.generateKey(request);
        const cached = await this.cacheManager.get<EditResponse>(cacheKey);
        
        if (cached) {
          this.metrics.cacheHits++;
          return cached;
        }
        this.metrics.cacheMisses++;
      }

      // Optimize request
      const { optimizedRequest, optimizations } = await this.optimizeRequest(request);

      // Process with progressive processor if needed
      let response: EditResponse;
      if (this.config.enableProgressive && this.shouldUseProgressive(optimizedRequest)) {
        response = await this.processWithProgressive(optimizedRequest);
      } else {
        response = await this.processDirectly(optimizedRequest);
      }

      // Cache the response
      if (this.config.enableCaching) {
        const cacheKey = CacheManager.generateKey(request);
        await this.cacheManager.set(cacheKey, response, {
          ttl: 30 * 60 * 1000, // 30 minutes
          priority: 7,
          tags: ['edit_response']
        });
      }

      // Update metrics
      this.metrics.processingTime += Date.now() - startTime;
      this.metrics.apiCalls++;

      return response;

    } catch (error) {
      console.error('Request processing failed:', error);
      throw error;
    }
  }

  /**
   * Determine if progressive processing should be used
   */
  private shouldUseProgressive(request: EditRequest): boolean {
    // Use progressive processing for large images or many regions
    const hasLargeImage = request.originalImage.length > 1024 * 1024; // 1MB base64
    const hasManyRegions = request.regions.length > 5;
    const hasComplexMasks = request.regions.some(r => r.mask.coordinates.length > 100);

    return hasLargeImage || hasManyRegions || hasComplexMasks;
  }

  /**
   * Process with progressive processor
   */
  private async processWithProgressive(request: EditRequest): Promise<EditResponse> {
    const masks = request.regions.map(r => r.mask);
    
    const processedImage = await this.progressiveProcessor.processImageProgressively(
      request.originalImage,
      masks
    );

    return {
      editedImage: processedImage,
      regions: request.regions.map(r => ({
        regionId: r.mask.id,
        success: true,
        processingTime: 0
      })),
      metadata: {
        processingTime: 0,
        provider: request.provider || 'progressive',
        fallbackUsed: false
      }
    };
  }

  /**
   * Process directly without progressive processing
   */
  private async processDirectly(request: EditRequest): Promise<EditResponse> {
    // This would integrate with the actual image editing API
    // For now, return a mock response
    return {
      editedImage: request.originalImage, // Mock: return original
      regions: request.regions.map(r => ({
        regionId: r.mask.id,
        success: true,
        processingTime: 100
      })),
      metadata: {
        processingTime: 100,
        provider: request.provider || 'direct',
        fallbackUsed: false
      }
    };
  }

  /**
   * Initialize optimization strategies
   */
  private initializeStrategies(): void {
    // Cache optimization strategy
    this.strategies.push({
      name: 'cache_optimization',
      priority: 10,
      enabled: this.config.enableCaching,
      apply: async (request: EditRequest) => {
        const startTime = Date.now();
        
        // Prefetch related data
        await this.cacheManager.prefetch(request);
        
        return {
          optimized: true,
          strategy: 'cache_optimization',
          timeSaved: Date.now() - startTime,
          memorySaved: 0
        };
      }
    });

    // Memory optimization strategy
    this.strategies.push({
      name: 'memory_optimization',
      priority: 8,
      enabled: this.config.enableMemoryOptimization,
      apply: async (request: EditRequest) => {
        const startTime = Date.now();
        const beforeMemory = this.memoryManager.getStats().currentUsage;
        
        // Optimize memory usage
        this.memoryManager.optimize();
        
        const afterMemory = this.memoryManager.getStats().currentUsage;
        
        return {
          optimized: beforeMemory > afterMemory,
          strategy: 'memory_optimization',
          timeSaved: 0,
          memorySaved: beforeMemory - afterMemory
        };
      }
    });

    // Request optimization strategy
    this.strategies.push({
      name: 'request_optimization',
      priority: 6,
      enabled: true,
      apply: async (request: EditRequest) => {
        const startTime = Date.now();
        
        // Optimize mask data
        let optimized = false;
        for (const region of request.regions) {
          // Simplify complex masks
          if (region.mask.coordinates.length > 1000) {
            // In a real implementation, this would simplify the mask
            optimized = true;
          }
        }
        
        return {
          optimized,
          strategy: 'request_optimization',
          timeSaved: Date.now() - startTime,
          memorySaved: 0
        };
      }
    });
  }

  /**
   * Get performance metrics
   */
  getMetrics(): PerformanceMetrics & {
    batchQueueSize: number;
    optimizationStrategies: number;
  } {
    return {
      ...this.metrics,
      batchQueueSize: this.batchQueue.length,
      optimizationStrategies: this.strategies.filter(s => s.enabled).length
    };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<PerformanceConfig>): void {
    this.config = { ...this.config, ...config };
    
    // Update strategy enabled states
    this.strategies.forEach(strategy => {
      switch (strategy.name) {
        case 'cache_optimization':
          strategy.enabled = this.config.enableCaching;
          break;
        case 'memory_optimization':
          strategy.enabled = this.config.enableMemoryOptimization;
          break;
      }
    });
  }

  /**
   * Add custom optimization strategy
   */
  addStrategy(strategy: OptimizationStrategy): void {
    this.strategies.push(strategy);
    this.strategies.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Remove optimization strategy
   */
  removeStrategy(name: string): boolean {
    const index = this.strategies.findIndex(s => s.name === name);
    if (index > -1) {
      this.strategies.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    
    this.batchQueue = [];
    this.strategies = [];
  }
}

// Global performance optimizer instance
let globalPerformanceOptimizer: PerformanceOptimizer | null = null;

/**
 * Get or create global performance optimizer
 */
export function getPerformanceOptimizer(config?: Partial<PerformanceConfig>): PerformanceOptimizer {
  if (!globalPerformanceOptimizer) {
    globalPerformanceOptimizer = new PerformanceOptimizer(config);
  }
  return globalPerformanceOptimizer;
}

export default PerformanceOptimizer;