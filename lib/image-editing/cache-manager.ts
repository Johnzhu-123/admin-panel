/**
 * Advanced Caching and Optimization Strategies
 * Implements multi-level caching, intelligent prefetching, and performance optimization
 */

import { Mask, EditRequest, EditResponse, PerformanceMetrics } from './types';
import { getMemoryManager, estimateObjectSize } from './memory-manager';

export interface CacheEntry<T = any> {
  key: string;
  data: T;
  timestamp: number;
  accessCount: number;
  lastAccessed: number;
  size: number;
  ttl?: number; // time to live in milliseconds
  priority: number; // 1-10, higher = more important
  tags: string[]; // for cache invalidation
}

export interface CacheStats {
  totalEntries: number;
  totalSize: number;
  hitRate: number;
  missRate: number;
  evictionCount: number;
  averageAccessTime: number;
}

export interface CacheOptions {
  maxSize: number; // in bytes
  maxEntries: number;
  defaultTTL: number; // in milliseconds
  enableCompression: boolean;
  enablePrefetching: boolean;
  evictionStrategy: 'lru' | 'lfu' | 'ttl' | 'priority';
  compressionThreshold: number; // compress entries larger than this
}

export interface PrefetchStrategy {
  name: string;
  predict: (request: EditRequest) => string[]; // return cache keys to prefetch
  priority: number;
}

export class CacheManager {
  private cache: Map<string, CacheEntry> = new Map();
  private accessTimes: Map<string, number[]> = new Map();
  private options: CacheOptions;
  private stats: CacheStats;
  private prefetchStrategies: PrefetchStrategy[] = [];
  private compressionWorker?: Worker;

  constructor(options: Partial<CacheOptions> = {}) {
    this.options = {
      maxSize: 100 * 1024 * 1024, // 100MB
      maxEntries: 1000,
      defaultTTL: 30 * 60 * 1000, // 30 minutes
      enableCompression: true,
      enablePrefetching: true,
      evictionStrategy: 'lru',
      compressionThreshold: 10 * 1024, // 10KB
      ...options
    };

    this.stats = {
      totalEntries: 0,
      totalSize: 0,
      hitRate: 0,
      missRate: 0,
      evictionCount: 0,
      averageAccessTime: 0
    };

    this.initializePrefetchStrategies();
    this.initializeCompression();
  }

  /**
   * Store data in cache
   */
  async set<T>(
    key: string, 
    data: T, 
    options: {
      ttl?: number;
      priority?: number;
      tags?: string[];
      compress?: boolean;
    } = {}
  ): Promise<void> {
    const size = estimateObjectSize(data);
    const shouldCompress = this.options.enableCompression && 
                          (options.compress ?? size > this.options.compressionThreshold);

    let processedData = data;
    let actualSize = size;

    if (shouldCompress) {
      try {
        processedData = await this.compress(data);
        actualSize = estimateObjectSize(processedData);
      } catch (error) {
        console.warn('Compression failed, storing uncompressed:', error);
      }
    }

    const entry: CacheEntry<T> = {
      key,
      data: processedData,
      timestamp: Date.now(),
      accessCount: 0,
      lastAccessed: Date.now(),
      size: actualSize,
      ttl: options.ttl ?? this.options.defaultTTL,
      priority: options.priority ?? 5,
      tags: options.tags ?? []
    };

    // Check if we need to evict entries
    await this.ensureCapacity(actualSize);

    this.cache.set(key, entry);
    this.updateStats();

    // Register with memory manager
    const memoryManager = getMemoryManager();
    memoryManager.register({
      id: `cache_${key}`,
      type: 'cache',
      size: actualSize,
      priority: entry.priority,
      data: processedData,
      cleanup: () => this.delete(key)
    });
  }

  /**
   * Retrieve data from cache
   */
  async get<T>(key: string): Promise<T | null> {
    const startTime = Date.now();
    const entry = this.cache.get(key);

    if (!entry) {
      this.recordMiss();
      return null;
    }

    // Check TTL
    if (entry.ttl && Date.now() - entry.timestamp > entry.ttl) {
      this.delete(key);
      this.recordMiss();
      return null;
    }

    // Update access statistics
    entry.accessCount++;
    entry.lastAccessed = Date.now();
    
    const accessTime = Date.now() - startTime;
    this.recordAccess(key, accessTime);
    this.recordHit();

    // Decompress if needed
    let data = entry.data;
    if (this.isCompressed(entry.data)) {
      try {
        data = await this.decompress(entry.data);
      } catch (error) {
        console.error('Decompression failed:', error);
        this.delete(key);
        return null;
      }
    }

    return data as T;
  }

  /**
   * Check if key exists in cache
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    // Check TTL
    if (entry.ttl && Date.now() - entry.timestamp > entry.ttl) {
      this.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Delete entry from cache
   */
  delete(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    this.cache.delete(key);
    this.accessTimes.delete(key);
    this.updateStats();

    // Unregister from memory manager
    const memoryManager = getMemoryManager();
    memoryManager.unregister(`cache_${key}`);

    return true;
  }

  /**
   * Clear cache with optional tag filtering
   */
  clear(tags?: string[]): number {
    let cleared = 0;

    if (!tags) {
      cleared = this.cache.size;
      this.cache.clear();
      this.accessTimes.clear();
    } else {
      for (const [key, entry] of this.cache.entries()) {
        if (entry.tags.some(tag => tags.includes(tag))) {
          this.delete(key);
          cleared++;
        }
      }
    }

    this.updateStats();
    return cleared;
  }

  /**
   * Prefetch data based on request patterns
   */
  async prefetch(request: EditRequest): Promise<void> {
    if (!this.options.enablePrefetching) return;

    const prefetchKeys = new Set<string>();

    // Run all prefetch strategies
    for (const strategy of this.prefetchStrategies) {
      try {
        const keys = strategy.predict(request);
        keys.forEach(key => prefetchKeys.add(key));
      } catch (error) {
        console.warn(`Prefetch strategy ${strategy.name} failed:`, error);
      }
    }

    // Execute prefetching (this would integrate with actual data sources)
    for (const key of prefetchKeys) {
      if (!this.has(key)) {
        // In a real implementation, this would fetch the data
        // For now, we'll just mark it as a prefetch opportunity
        console.debug(`Prefetch opportunity: ${key}`);
      }
    }
  }

  /**
   * Optimize cache performance
   */
  async optimize(): Promise<{
    compressed: number;
    evicted: number;
    defragmented: boolean;
  }> {
    const result = {
      compressed: 0,
      evicted: 0,
      defragmented: false
    };

    // Compress large uncompressed entries
    for (const [key, entry] of this.cache.entries()) {
      if (!this.isCompressed(entry.data) && 
          entry.size > this.options.compressionThreshold) {
        try {
          const compressed = await this.compress(entry.data);
          const newSize = estimateObjectSize(compressed);
          
          if (newSize < entry.size * 0.8) { // Only if significant compression
            entry.data = compressed;
            entry.size = newSize;
            result.compressed++;
          }
        } catch (error) {
          console.warn(`Failed to compress cache entry ${key}:`, error);
        }
      }
    }

    // Evict expired entries
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (entry.ttl && now - entry.timestamp > entry.ttl) {
        this.delete(key);
        result.evicted++;
      }
    }

    // Defragment if needed (reorganize cache for better performance)
    if (this.cache.size > this.options.maxEntries * 0.8) {
      await this.defragment();
      result.defragmented = true;
    }

    this.updateStats();
    return result;
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Get cache entries sorted by various criteria
   */
  getEntries(sortBy: 'access' | 'size' | 'age' | 'priority' = 'access'): CacheEntry[] {
    const entries = Array.from(this.cache.values());

    switch (sortBy) {
      case 'access':
        return entries.sort((a, b) => b.accessCount - a.accessCount);
      case 'size':
        return entries.sort((a, b) => b.size - a.size);
      case 'age':
        return entries.sort((a, b) => a.timestamp - b.timestamp);
      case 'priority':
        return entries.sort((a, b) => b.priority - a.priority);
      default:
        return entries;
    }
  }

  /**
   * Add custom prefetch strategy
   */
  addPrefetchStrategy(strategy: PrefetchStrategy): void {
    this.prefetchStrategies.push(strategy);
    this.prefetchStrategies.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Remove prefetch strategy
   */
  removePrefetchStrategy(name: string): boolean {
    const index = this.prefetchStrategies.findIndex(s => s.name === name);
    if (index > -1) {
      this.prefetchStrategies.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Generate cache key for edit request
   */
  static generateKey(request: EditRequest): string {
    const maskHashes = request.regions.map(region => {
      const mask = region.mask;
      return `${mask.type}_${mask.bounds.x}_${mask.bounds.y}_${mask.bounds.width}_${mask.bounds.height}_${region.instruction}`;
    }).join('|');

    const optionsHash = `${request.globalOptions.highFidelity}_${request.globalOptions.stylePreservation}_${request.globalOptions.qualityLevel}`;
    
    // Create a simple hash of the image data (first and last 100 chars)
    const imageHash = request.originalImage.length > 200 
      ? request.originalImage.substring(0, 100) + request.originalImage.substring(request.originalImage.length - 100)
      : request.originalImage;

    return `edit_${this.simpleHash(imageHash + maskHashes + optionsHash)}`;
  }

  /**
   * Simple hash function for cache keys
   */
  private static simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Ensure cache has capacity for new entry
   */
  private async ensureCapacity(newEntrySize: number): Promise<void> {
    const currentSize = this.getCurrentSize();
    const currentEntries = this.cache.size;

    // Check size limit
    if (currentSize + newEntrySize > this.options.maxSize) {
      await this.evictBySize(currentSize + newEntrySize - this.options.maxSize);
    }

    // Check entry limit
    if (currentEntries >= this.options.maxEntries) {
      await this.evictByCount(currentEntries - this.options.maxEntries + 1);
    }
  }

  /**
   * Evict entries by size
   */
  private async evictBySize(bytesToEvict: number): Promise<void> {
    const candidates = this.getEvictionCandidates();
    let evicted = 0;

    for (const entry of candidates) {
      if (evicted >= bytesToEvict) break;
      
      this.delete(entry.key);
      evicted += entry.size;
      this.stats.evictionCount++;
    }
  }

  /**
   * Evict entries by count
   */
  private async evictByCount(countToEvict: number): Promise<void> {
    const candidates = this.getEvictionCandidates();
    
    for (let i = 0; i < Math.min(countToEvict, candidates.length); i++) {
      this.delete(candidates[i].key);
      this.stats.evictionCount++;
    }
  }

  /**
   * Get eviction candidates based on strategy
   */
  private getEvictionCandidates(): CacheEntry[] {
    const entries = Array.from(this.cache.values());

    switch (this.options.evictionStrategy) {
      case 'lru':
        return entries.sort((a, b) => a.lastAccessed - b.lastAccessed);
      case 'lfu':
        return entries.sort((a, b) => a.accessCount - b.accessCount);
      case 'ttl':
        return entries.sort((a, b) => {
          const aExpiry = a.timestamp + (a.ttl || this.options.defaultTTL);
          const bExpiry = b.timestamp + (b.ttl || this.options.defaultTTL);
          return aExpiry - bExpiry;
        });
      case 'priority':
        return entries.sort((a, b) => a.priority - b.priority);
      default:
        return entries;
    }
  }

  /**
   * Defragment cache for better performance
   */
  private async defragment(): Promise<void> {
    // Create new cache with optimized layout
    const entries = this.getEntries('priority');
    const newCache = new Map<string, CacheEntry>();

    // Re-add entries in priority order
    for (const entry of entries) {
      newCache.set(entry.key, entry);
    }

    this.cache = newCache;
  }

  /**
   * Get current cache size
   */
  private getCurrentSize(): number {
    let size = 0;
    for (const entry of this.cache.values()) {
      size += entry.size;
    }
    return size;
  }

  /**
   * Update cache statistics
   */
  private updateStats(): void {
    this.stats.totalEntries = this.cache.size;
    this.stats.totalSize = this.getCurrentSize();

    // Calculate average access time
    const allAccessTimes = Array.from(this.accessTimes.values()).flat();
    this.stats.averageAccessTime = allAccessTimes.length > 0
      ? allAccessTimes.reduce((sum, time) => sum + time, 0) / allAccessTimes.length
      : 0;
  }

  /**
   * Record cache hit
   */
  private recordHit(): void {
    // This would be implemented with proper metrics tracking
  }

  /**
   * Record cache miss
   */
  private recordMiss(): void {
    // This would be implemented with proper metrics tracking
  }

  /**
   * Record access time
   */
  private recordAccess(key: string, time: number): void {
    if (!this.accessTimes.has(key)) {
      this.accessTimes.set(key, []);
    }
    
    const times = this.accessTimes.get(key)!;
    times.push(time);
    
    // Keep only last 10 access times
    if (times.length > 10) {
      times.shift();
    }
  }

  /**
   * Initialize prefetch strategies
   */
  private initializePrefetchStrategies(): void {
    // Similar masks strategy
    this.addPrefetchStrategy({
      name: 'similar_masks',
      priority: 8,
      predict: (request: EditRequest) => {
        const keys: string[] = [];
        
        // Generate keys for similar mask configurations
        request.regions.forEach(region => {
          const mask = region.mask;
          
          // Predict similar sized masks
          const variations = [
            { ...mask, bounds: { ...mask.bounds, width: mask.bounds.width * 1.1, height: mask.bounds.height * 1.1 } },
            { ...mask, bounds: { ...mask.bounds, width: mask.bounds.width * 0.9, height: mask.bounds.height * 0.9 } }
          ];
          
          variations.forEach(variation => {
            const variantRequest = {
              ...request,
              regions: [{ ...region, mask: variation }]
            };
            keys.push(CacheManager.generateKey(variantRequest));
          });
        });
        
        return keys;
      }
    });

    // Quality variations strategy
    this.addPrefetchStrategy({
      name: 'quality_variations',
      priority: 6,
      predict: (request: EditRequest) => {
        const keys: string[] = [];
        const qualityLevels: ('standard' | 'high')[] = ['standard', 'high'];
        
        qualityLevels.forEach(quality => {
          if (quality !== request.globalOptions.qualityLevel) {
            const variantRequest = {
              ...request,
              globalOptions: { ...request.globalOptions, qualityLevel: quality }
            };
            keys.push(CacheManager.generateKey(variantRequest));
          }
        });
        
        return keys;
      }
    });
  }

  /**
   * Initialize compression support
   */
  private initializeCompression(): void {
    if (this.options.enableCompression && typeof Worker !== 'undefined') {
      try {
        // In a real implementation, this would use a compression worker
        // For now, we'll use a simple compression simulation
      } catch (error) {
        console.warn('Compression worker initialization failed:', error);
      }
    }
  }

  /**
   * Compress data
   */
  private async compress<T>(data: T): Promise<any> {
    // Simple compression simulation
    // In a real implementation, this would use actual compression algorithms
    const serialized = JSON.stringify(data);
    return {
      __compressed: true,
      data: serialized,
      originalSize: estimateObjectSize(data)
    };
  }

  /**
   * Decompress data
   */
  private async decompress(compressedData: any): Promise<any> {
    if (compressedData.__compressed) {
      return JSON.parse(compressedData.data);
    }
    return compressedData;
  }

  /**
   * Check if data is compressed
   */
  private isCompressed(data: any): boolean {
    return data && typeof data === 'object' && data.__compressed === true;
  }
}

// Global cache manager instance
let globalCacheManager: CacheManager | null = null;

/**
 * Get or create global cache manager
 */
export function getCacheManager(options?: Partial<CacheOptions>): CacheManager {
  if (!globalCacheManager) {
    globalCacheManager = new CacheManager(options);
  }
  return globalCacheManager;
}

/**
 * Cache decorator for functions
 */
export function cached<T extends (...args: any[]) => any>(
  keyGenerator: (...args: Parameters<T>) => string,
  options: {
    ttl?: number;
    priority?: number;
    tags?: string[];
  } = {}
) {
  return function (target: any, propertyName: string, descriptor: PropertyDescriptor) {
    const method = descriptor.value;
    
    descriptor.value = async function (...args: Parameters<T>) {
      const cache = getCacheManager();
      const key = keyGenerator(...args);
      
      // Try to get from cache
      const cached = await cache.get(key);
      if (cached !== null) {
        return cached;
      }
      
      // Execute original method
      const result = await method.apply(this, args);
      
      // Store in cache
      await cache.set(key, result, options);
      
      return result;
    };
  };
}

export default CacheManager;