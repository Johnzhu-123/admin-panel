// Performance Optimizer - Caching and performance optimization for API compatibility
// Validates: Requirements 10.1, 10.2, 10.3, 10.4

import {
  APIProvider,
  ProviderConfig,
  CompatibilityProfile,
  ImageGenerationRequest,
  ImageGenerationResponse
} from '../types';

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
  accessCount: number;
  lastAccessed: number;
}

export interface PerformanceMetrics {
  cacheHitRate: number;
  averageResponseTime: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  lastUpdated: Date;
}

export class PerformanceOptimizer {
  private configCache: Map<string, CacheEntry<ProviderConfig>> = new Map();
  private compatibilityCache: Map<string, CacheEntry<CompatibilityProfile>> = new Map();
  private responseCache: Map<string, CacheEntry<ImageGenerationResponse>> = new Map();
  private editResponseCache: Map<string, CacheEntry<any>> = new Map();
  private performanceMetrics: PerformanceMetrics;
  private requestTimes: Map<string, number> = new Map();

  // Cache configuration
  private readonly DEFAULT_CONFIG_TTL = 24 * 60 * 60 * 1000; // 24 hours
  private readonly DEFAULT_COMPATIBILITY_TTL = 60 * 60 * 1000; // 1 hour
  private readonly DEFAULT_RESPONSE_TTL = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_CACHE_SIZE = 1000;

  constructor() {
    this.performanceMetrics = {
      cacheHitRate: 0,
      averageResponseTime: 0,
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      lastUpdated: new Date()
    };

    // Start cache cleanup interval
    setInterval(() => this.cleanupExpiredEntries(), 5 * 60 * 1000); // Every 5 minutes
  }

  /**
   * Caches provider configuration with TTL
   * Validates: Requirements 10.1, 10.4
   */
  cacheProviderConfig(providerId: string, config: ProviderConfig, ttl?: number): void {
    const entry: CacheEntry<ProviderConfig> = {
      data: config,
      timestamp: Date.now(),
      ttl: ttl || this.DEFAULT_CONFIG_TTL,
      accessCount: 0,
      lastAccessed: Date.now()
    };

    this.configCache.set(providerId, entry);
    this.enforceMaxCacheSize(this.configCache);
  }

  /**
   * Gets cached provider configuration
   * Validates: Requirements 10.1, 10.4
   */
  getCachedProviderConfig(providerId: string): ProviderConfig | null {
    const entry = this.configCache.get(providerId);
    if (!entry) {
      return null;
    }

    // Check if expired
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.configCache.delete(providerId);
      return null;
    }

    // Update access statistics
    entry.accessCount++;
    entry.lastAccessed = Date.now();
    
    this.updateCacheHitRate(true);
    return entry.data;
  }

  /**
   * Caches compatibility profile with TTL
   * Validates: Requirements 10.1, 10.4
   */
  cacheCompatibilityProfile(providerId: string, profile: CompatibilityProfile, ttl?: number): void {
    const cacheKey = `${providerId}-${profile.detectedAt.getTime()}`;
    const entry: CacheEntry<CompatibilityProfile> = {
      data: profile,
      timestamp: Date.now(),
      ttl: ttl || this.DEFAULT_COMPATIBILITY_TTL,
      accessCount: 0,
      lastAccessed: Date.now()
    };

    this.compatibilityCache.set(cacheKey, entry);
    this.enforceMaxCacheSize(this.compatibilityCache);
  }

  /**
   * Gets cached compatibility profile
   * Validates: Requirements 10.1, 10.4
   */
  getCachedCompatibilityProfile(providerId: string): CompatibilityProfile | null {
    // Find the most recent profile for this provider
    let latestEntry: CacheEntry<CompatibilityProfile> | null = null;
    let latestKey = '';

    for (const [key, entry] of this.compatibilityCache) {
      if (key.startsWith(`${providerId}-`)) {
        // Check if expired
        if (Date.now() - entry.timestamp > entry.ttl) {
          this.compatibilityCache.delete(key);
          continue;
        }

        if (!latestEntry || entry.data.detectedAt > latestEntry.data.detectedAt) {
          latestEntry = entry;
          latestKey = key;
        }
      }
    }

    if (!latestEntry) {
      this.updateCacheHitRate(false);
      return null;
    }

    // Update access statistics
    latestEntry.accessCount++;
    latestEntry.lastAccessed = Date.now();
    
    this.updateCacheHitRate(true);
    return latestEntry.data;
  }

  /**
   * Caches API response for identical requests
   * Validates: Requirements 10.1, 10.2
   */
  cacheResponse(request: ImageGenerationRequest, provider: APIProvider, response: ImageGenerationResponse, ttl?: number): void {
    const cacheKey = this.generateRequestCacheKey(request, provider);
    const entry: CacheEntry<ImageGenerationResponse> = {
      data: response,
      timestamp: Date.now(),
      ttl: ttl || this.DEFAULT_RESPONSE_TTL,
      accessCount: 0,
      lastAccessed: Date.now()
    };

    this.responseCache.set(cacheKey, entry);
    this.enforceMaxCacheSize(this.responseCache);
  }

  /**
   * Gets cached API response
   * Validates: Requirements 10.1, 10.2
   */
  getCachedResponse(request: ImageGenerationRequest, provider: APIProvider): ImageGenerationResponse | null {
    const cacheKey = this.generateRequestCacheKey(request, provider);
    const entry = this.responseCache.get(cacheKey);
    
    if (!entry) {
      this.updateCacheHitRate(false);
      return null;
    }

    // Check if expired
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.responseCache.delete(cacheKey);
      this.updateCacheHitRate(false);
      return null;
    }

    // Update access statistics
    entry.accessCount++;
    entry.lastAccessed = Date.now();
    
    this.updateCacheHitRate(true);
    return entry.data;
  }

  /**
   * Starts performance tracking for a request
   * Validates: Requirements 10.2, 10.3
   */
  startRequestTracking(requestId: string): void {
    this.requestTimes.set(requestId, Date.now());
    this.performanceMetrics.totalRequests++;
  }

  /**
   * Ends performance tracking and records metrics
   * Validates: Requirements 10.2, 10.3
   */
  endRequestTracking(requestId: string, success: boolean): number {
    const startTime = this.requestTimes.get(requestId);
    if (!startTime) {
      return 0;
    }

    const duration = Date.now() - startTime;
    this.requestTimes.delete(requestId);

    // Update metrics
    if (success) {
      this.performanceMetrics.successfulRequests++;
    } else {
      this.performanceMetrics.failedRequests++;
    }

    // Update average response time
    const totalSuccessful = this.performanceMetrics.successfulRequests;
    if (totalSuccessful > 0) {
      this.performanceMetrics.averageResponseTime = 
        (this.performanceMetrics.averageResponseTime * (totalSuccessful - 1) + duration) / totalSuccessful;
    }

    this.performanceMetrics.lastUpdated = new Date();
    return duration;
  }

  /**
   * Executes multiple compatibility checks in parallel
   * Validates: Requirements 10.2
   */
  async executeParallelCompatibilityChecks<T>(
    tasks: Array<() => Promise<T>>,
    maxConcurrency: number = 5
  ): Promise<T[]> {
    const results: T[] = [];
    const executing: Promise<void>[] = [];

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      
      const promise = task().then(result => {
        results[i] = result;
      }).catch(error => {
        // Store error as result
        results[i] = error;
      });

      executing.push(promise);

      // Limit concurrency
      if (executing.length >= maxConcurrency) {
        await Promise.race(executing);
        // Remove completed promises
        for (let j = executing.length - 1; j >= 0; j--) {
          if (results[i] !== undefined) {
            executing.splice(j, 1);
          }
        }
      }
    }

    // Wait for all remaining tasks
    await Promise.all(executing);
    return results;
  }

  /**
   * Optimizes timeout configuration based on historical performance
   * Validates: Requirements 10.3
   */
  getOptimizedTimeout(providerId: string, baseTimeout: number = 30000): number {
    const profile = this.getCachedCompatibilityProfile(providerId);
    if (!profile) {
      return baseTimeout;
    }

    const networkLatency = profile.networkStatus.latency;
    
    // Adjust timeout based on network performance
    if (networkLatency > 5000) {
      return Math.min(baseTimeout * 2, 60000); // Max 60 seconds
    } else if (networkLatency > 2000) {
      return Math.min(baseTimeout * 1.5, 45000); // Max 45 seconds
    } else if (networkLatency < 500) {
      return Math.max(baseTimeout * 0.7, 10000); // Min 10 seconds
    }

    return baseTimeout;
  }

  /**
   * Prioritizes providers based on historical success rates
   * Validates: Requirements 10.4
   */
  prioritizeProviders(providers: APIProvider[]): APIProvider[] {
    const providerScores = new Map<string, number>();

    for (const provider of providers) {
      let score = 0;
      
      // Check cache hit rate (higher is better)
      const config = this.getCachedProviderConfig(provider.id);
      if (config) {
        score += 10;
      }

      // Check compatibility profile
      const profile = this.getCachedCompatibilityProfile(provider.id);
      if (profile) {
        score += 5;
        
        // Network performance bonus
        if (profile.networkStatus.latency < 1000) {
          score += 5;
        } else if (profile.networkStatus.latency < 3000) {
          score += 2;
        }

        // Stability bonus
        if (profile.networkStatus.tlsSupported && profile.networkStatus.dnsResolvable) {
          score += 3;
        }
      }

      providerScores.set(provider.id, score);
    }

    // Sort providers by score (descending)
    return providers.sort((a, b) => {
      const scoreA = providerScores.get(a.id) || 0;
      const scoreB = providerScores.get(b.id) || 0;
      return scoreB - scoreA;
    });
  }

  /**
   * Gets current performance metrics
   * Validates: Requirements 10.1, 10.2, 10.3
   */
  getPerformanceMetrics(): PerformanceMetrics {
    return { ...this.performanceMetrics };
  }

  /**
   * Clears all caches
   * Public method for cache management
   */
  clearAllCaches(): void {
    this.configCache.clear();
    this.compatibilityCache.clear();
    this.responseCache.clear();
    this.editResponseCache.clear();
    this.requestTimes.clear();
  }

  /**
   * Gets cache statistics
   * Public method for monitoring
   */
  getCacheStatistics() {
    return {
      configCache: {
        size: this.configCache.size,
        entries: Array.from(this.configCache.entries()).map(([key, entry]) => ({
          key,
          accessCount: entry.accessCount,
          lastAccessed: new Date(entry.lastAccessed),
          age: Date.now() - entry.timestamp
        }))
      },
      compatibilityCache: {
        size: this.compatibilityCache.size,
        entries: Array.from(this.compatibilityCache.entries()).map(([key, entry]) => ({
          key,
          accessCount: entry.accessCount,
          lastAccessed: new Date(entry.lastAccessed),
          age: Date.now() - entry.timestamp
        }))
      },
      responseCache: {
        size: this.responseCache.size,
        entries: Array.from(this.responseCache.entries()).map(([key, entry]) => ({
          key: key.substring(0, 50) + '...', // Truncate for readability
          accessCount: entry.accessCount,
          lastAccessed: new Date(entry.lastAccessed),
          age: Date.now() - entry.timestamp
        }))
      },
      editResponseCache: {
        size: this.editResponseCache.size,
        entries: Array.from(this.editResponseCache.entries()).map(([key, entry]) => ({
          key: key.substring(0, 50) + '...', // Truncate for readability
          accessCount: entry.accessCount,
          lastAccessed: new Date(entry.lastAccessed),
          age: Date.now() - entry.timestamp
        }))
      }
    };
  }

  /**
   * Generates a cache key for API requests
   * Private helper method
   */
  private generateRequestCacheKey(request: ImageGenerationRequest, provider: APIProvider): string {
    const keyData = {
      providerId: provider.id,
      prompt: request.prompt,
      model: request.model,
      size: request.size,
      quality: request.quality,
      response_format: request.response_format,
      n: request.n
    };
    
    return Buffer.from(JSON.stringify(keyData)).toString('base64');
  }

  /**
   * Updates cache hit rate statistics
   * Private helper method
   */
  private updateCacheHitRate(hit: boolean): void {
    const totalCacheRequests = this.performanceMetrics.totalRequests;
    if (totalCacheRequests === 0) {
      this.performanceMetrics.cacheHitRate = hit ? 1 : 0;
    } else {
      const currentHits = this.performanceMetrics.cacheHitRate * totalCacheRequests;
      const newHits = hit ? currentHits + 1 : currentHits;
      this.performanceMetrics.cacheHitRate = newHits / (totalCacheRequests + 1);
    }
  }

  /**
   * Enforces maximum cache size by removing least recently used entries
   * Private helper method
   */
  private enforceMaxCacheSize<T>(cache: Map<string, CacheEntry<T>>): void {
    if (cache.size <= this.MAX_CACHE_SIZE) {
      return;
    }

    // Sort entries by last accessed time (ascending)
    const entries = Array.from(cache.entries()).sort((a, b) => 
      a[1].lastAccessed - b[1].lastAccessed
    );

    // Remove oldest entries
    const toRemove = cache.size - this.MAX_CACHE_SIZE;
    for (let i = 0; i < toRemove; i++) {
      cache.delete(entries[i][0]);
    }
  }

  /**
   * Cleans up expired cache entries
   * Private helper method
   */
  private cleanupExpiredEntries(): void {
    const now = Date.now();

    // Clean config cache
    for (const [key, entry] of this.configCache) {
      if (now - entry.timestamp > entry.ttl) {
        this.configCache.delete(key);
      }
    }

    // Clean compatibility cache
    for (const [key, entry] of this.compatibilityCache) {
      if (now - entry.timestamp > entry.ttl) {
        this.compatibilityCache.delete(key);
      }
    }

    // Clean response cache
    for (const [key, entry] of this.responseCache) {
      if (now - entry.timestamp > entry.ttl) {
        this.responseCache.delete(key);
      }
    }

    // Clean edit response cache
    for (const [key, entry] of this.editResponseCache) {
      if (now - entry.timestamp > entry.ttl) {
        this.editResponseCache.delete(key);
      }
    }
  }

  // Editing-specific caching methods

  /**
   * Caches edit response for identical edit requests
   * Validates: Requirements 10.1, 10.2 (extended for editing)
   */
  cacheEditResponse(cacheKey: string, response: any, ttl?: number): void {
    const entry: CacheEntry<any> = {
      data: response,
      timestamp: Date.now(),
      ttl: ttl || this.DEFAULT_RESPONSE_TTL,
      accessCount: 0,
      lastAccessed: Date.now()
    };

    this.editResponseCache.set(cacheKey, entry);
    this.enforceMaxCacheSize(this.editResponseCache);
  }

  /**
   * Gets cached edit response
   * Validates: Requirements 10.1, 10.2 (extended for editing)
   */
  getCachedEditResponse(cacheKey: string): any | null {
    const entry = this.editResponseCache.get(cacheKey);
    
    if (!entry) {
      this.updateCacheHitRate(false);
      return null;
    }

    // Check if expired
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.editResponseCache.delete(cacheKey);
      this.updateCacheHitRate(false);
      return null;
    }

    // Update access statistics
    entry.accessCount++;
    entry.lastAccessed = Date.now();
    
    this.updateCacheHitRate(true);
    return entry.data;
  }
}