/**
 * Performance Optimizer for Built-in API Service
 * Implements caching, connection pooling, and performance optimizations
 * Validates: Requirements 7.2
 */

export interface CacheEntry {
  key: string;
  data: any;
  timestamp: Date;
  expiresAt: Date;
  accessCount: number;
  lastAccessed: Date;
  size: number; // in bytes
}

export interface ConnectionPoolConfig {
  maxConnections: number;
  maxIdleTime: number; // ms
  connectionTimeout: number; // ms
  retryAttempts: number;
  retryDelay: number; // ms
}

export interface CacheConfig {
  maxSize: number; // in bytes
  maxEntries: number;
  defaultTTL: number; // ms
  cleanupInterval: number; // ms
}

export interface PerformanceMetrics {
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;
  averageResponseTime: number;
  activeConnections: number;
  totalRequests: number;
  errorRate: number;
}

export class PerformanceOptimizer {
  private cache = new Map<string, CacheEntry>();
  private connectionPool = new Map<string, any>();
  private requestQueue: Array<{ resolve: Function; reject: Function; request: any }> = [];
  private activeRequests = new Set<string>();
  
  private metrics = {
    cacheHits: 0,
    cacheMisses: 0,
    totalRequests: 0,
    totalErrors: 0,
    totalResponseTime: 0,
    startTime: Date.now()
  };

  private cacheConfig: CacheConfig;
  private connectionConfig: ConnectionPoolConfig;
  private cleanupInterval: NodeJS.Timeout;

  constructor(
    cacheConfig?: Partial<CacheConfig>,
    connectionConfig?: Partial<ConnectionPoolConfig>
  ) {
    this.cacheConfig = {
      maxSize: 100 * 1024 * 1024, // 100MB
      maxEntries: 1000,
      defaultTTL: 5 * 60 * 1000, // 5 minutes
      cleanupInterval: 60 * 1000, // 1 minute
      ...cacheConfig
    };

    this.connectionConfig = {
      maxConnections: 10,
      maxIdleTime: 30 * 1000, // 30 seconds
      connectionTimeout: 10 * 1000, // 10 seconds
      retryAttempts: 3,
      retryDelay: 1000, // 1 second
      ...connectionConfig
    };

    // Start cleanup interval
    this.cleanupInterval = setInterval(() => {
      this.cleanupCache();
      this.cleanupConnections();
    }, this.cacheConfig.cleanupInterval);
  }

  /**
   * Get cached response if available
   */
  getCachedResponse(cacheKey: string): any | null {
    const entry = this.cache.get(cacheKey);
    
    if (!entry) {
      this.metrics.cacheMisses++;
      return null;
    }

    // Check if entry has expired
    if (Date.now() > entry.expiresAt.getTime()) {
      this.cache.delete(cacheKey);
      this.metrics.cacheMisses++;
      return null;
    }

    // Update access statistics
    entry.accessCount++;
    entry.lastAccessed = new Date();
    
    this.metrics.cacheHits++;
    
    console.log(`🎯 Cache HIT: ${cacheKey} (accessed ${entry.accessCount} times)`);
    return entry.data;
  }

  /**
   * Cache a response
   */
  cacheResponse(cacheKey: string, data: any, ttl?: number): void {
    try {
      const serializedData = JSON.stringify(data);
      const size = new Blob([serializedData]).size;
      
      // Check if we need to make space
      this.ensureCacheSpace(size);

      const entry: CacheEntry = {
        key: cacheKey,
        data,
        timestamp: new Date(),
        expiresAt: new Date(Date.now() + (ttl || this.cacheConfig.defaultTTL)),
        accessCount: 0,
        lastAccessed: new Date(),
        size
      };

      this.cache.set(cacheKey, entry);
      
      console.log(`💾 Cached response: ${cacheKey} (${size} bytes, TTL: ${ttl || this.cacheConfig.defaultTTL}ms)`);
    } catch (error) {
      console.error('Error caching response:', error);
    }
  }

  /**
   * Generate cache key for request
   */
  generateCacheKey(request: {
    userId: string;
    serviceId: string;
    prompt: string;
    model?: string;
    size?: string;
    quality?: string;
  }): string {
    // Create a deterministic cache key based on request parameters
    const keyData = {
      serviceId: request.serviceId,
      prompt: request.prompt.trim().toLowerCase(),
      model: request.model || 'default',
      size: request.size || 'default',
      quality: request.quality || 'standard'
    };

    // Create hash of the key data
    const keyString = JSON.stringify(keyData);
    return `img_${this.simpleHash(keyString)}`;
  }

  /**
   * Simple hash function for cache keys
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Ensure cache has enough space
   */
  private ensureCacheSpace(requiredSize: number): void {
    // Check total size
    let totalSize = 0;
    for (const entry of this.cache.values()) {
      totalSize += entry.size;
    }

    // Remove entries if we exceed limits
    while (
      (totalSize + requiredSize > this.cacheConfig.maxSize) ||
      (this.cache.size >= this.cacheConfig.maxEntries)
    ) {
      const oldestEntry = this.findLeastRecentlyUsed();
      if (oldestEntry) {
        this.cache.delete(oldestEntry.key);
        totalSize -= oldestEntry.size;
        console.log(`🗑️ Evicted cache entry: ${oldestEntry.key} (${oldestEntry.size} bytes)`);
      } else {
        break;
      }
    }
  }

  /**
   * Find least recently used cache entry
   */
  private findLeastRecentlyUsed(): CacheEntry | null {
    let oldest: CacheEntry | null = null;
    let oldestTime = Date.now();

    for (const entry of this.cache.values()) {
      if (entry.lastAccessed.getTime() < oldestTime) {
        oldest = entry;
        oldestTime = entry.lastAccessed.getTime();
      }
    }

    return oldest;
  }

  /**
   * Clean up expired cache entries
   */
  private cleanupCache(): void {
    const now = Date.now();
    let cleanedCount = 0;
    let freedSize = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt.getTime()) {
        this.cache.delete(key);
        cleanedCount++;
        freedSize += entry.size;
      }
    }

    if (cleanedCount > 0) {
      console.log(`🧹 Cache cleanup: removed ${cleanedCount} expired entries, freed ${freedSize} bytes`);
    }
  }

  /**
   * Get or create connection for service
   */
  async getConnection(serviceId: string, baseUrl: string): Promise<any> {
    const connectionKey = `${serviceId}_${baseUrl}`;
    
    let connection = this.connectionPool.get(connectionKey);
    
    if (!connection || this.isConnectionStale(connection)) {
      connection = await this.createConnection(serviceId, baseUrl);
      this.connectionPool.set(connectionKey, connection);
      
      console.log(`🔗 Created new connection: ${connectionKey}`);
    } else {
      console.log(`♻️ Reusing connection: ${connectionKey}`);
    }

    return connection;
  }

  /**
   * Create new connection
   */
  private async createConnection(serviceId: string, baseUrl: string): Promise<any> {
    return {
      serviceId,
      baseUrl,
      createdAt: new Date(),
      lastUsed: new Date(),
      requestCount: 0,
      isActive: true
    };
  }

  /**
   * Check if connection is stale
   */
  private isConnectionStale(connection: any): boolean {
    const now = Date.now();
    const lastUsed = connection.lastUsed.getTime();
    return (now - lastUsed) > this.connectionConfig.maxIdleTime;
  }

  /**
   * Clean up stale connections
   */
  private cleanupConnections(): void {
    let cleanedCount = 0;
    
    for (const [key, connection] of this.connectionPool.entries()) {
      if (this.isConnectionStale(connection)) {
        this.connectionPool.delete(key);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      console.log(`🧹 Connection cleanup: removed ${cleanedCount} stale connections`);
    }
  }

  /**
   * Execute request with performance optimizations
   */
  async executeOptimizedRequest(
    request: any,
    executor: (request: any) => Promise<any>
  ): Promise<any> {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const startTime = Date.now();
    
    this.metrics.totalRequests++;
    this.activeRequests.add(requestId);

    try {
      // Check cache first
      const cacheKey = this.generateCacheKey(request);
      const cachedResponse = this.getCachedResponse(cacheKey);
      
      if (cachedResponse) {
        const responseTime = Date.now() - startTime;
        this.metrics.totalResponseTime += responseTime;
        
        console.log(`⚡ Cache hit: ${requestId} completed in ${responseTime}ms`);
        return cachedResponse;
      }

      // Execute request with retry logic
      const response = await this.executeWithRetry(executor, request);
      
      // Cache successful response
      if (response && !response.error) {
        this.cacheResponse(cacheKey, response);
      }

      const responseTime = Date.now() - startTime;
      this.metrics.totalResponseTime += responseTime;
      
      console.log(`🚀 Request completed: ${requestId} in ${responseTime}ms`);
      return response;

    } catch (error) {
      this.metrics.totalErrors++;
      
      const responseTime = Date.now() - startTime;
      this.metrics.totalResponseTime += responseTime;
      
      console.error(`❌ Request failed: ${requestId} in ${responseTime}ms`, error);
      throw error;
      
    } finally {
      this.activeRequests.delete(requestId);
    }
  }

  /**
   * Execute request with retry logic
   */
  private async executeWithRetry(
    executor: (request: any) => Promise<any>,
    request: any,
    attempt: number = 1
  ): Promise<any> {
    try {
      return await executor(request);
    } catch (error) {
      if (attempt < this.connectionConfig.retryAttempts) {
        const delay = this.connectionConfig.retryDelay * attempt;
        console.log(`🔄 Retrying request (attempt ${attempt + 1}/${this.connectionConfig.retryAttempts}) in ${delay}ms`);
        
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.executeWithRetry(executor, request, attempt + 1);
      } else {
        throw error;
      }
    }
  }

  /**
   * Batch multiple requests for efficiency
   */
  async batchRequests(
    requests: any[],
    executor: (request: any) => Promise<any>,
    batchSize: number = 5
  ): Promise<any[]> {
    const results: any[] = [];
    
    for (let i = 0; i < requests.length; i += batchSize) {
      const batch = requests.slice(i, i + batchSize);
      
      const batchPromises = batch.map(request => 
        this.executeOptimizedRequest(request, executor)
      );
      
      const batchResults = await Promise.allSettled(batchPromises);
      
      batchResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          console.error(`Batch request ${i + index} failed:`, result.reason);
          results.push({ error: result.reason });
        }
      });
      
      // Small delay between batches to avoid overwhelming the service
      if (i + batchSize < requests.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    return results;
  }

  /**
   * Preload cache with common requests
   */
  async preloadCache(commonRequests: any[], executor: (request: any) => Promise<any>): Promise<void> {
    console.log(`🔄 Preloading cache with ${commonRequests.length} common requests...`);
    
    for (const request of commonRequests) {
      try {
        const cacheKey = this.generateCacheKey(request);
        
        // Only preload if not already cached
        if (!this.cache.has(cacheKey)) {
          const response = await executor(request);
          this.cacheResponse(cacheKey, response, this.cacheConfig.defaultTTL * 2); // Longer TTL for preloaded items
        }
      } catch (error) {
        console.error('Error preloading cache entry:', error);
      }
    }
    
    console.log(`✅ Cache preloading completed`);
  }

  /**
   * Get performance metrics
   */
  getPerformanceMetrics(): PerformanceMetrics {
    const totalRequests = this.metrics.totalRequests;
    const cacheHitRate = totalRequests > 0 ? 
      (this.metrics.cacheHits / (this.metrics.cacheHits + this.metrics.cacheMisses)) * 100 : 0;
    
    const averageResponseTime = totalRequests > 0 ? 
      this.metrics.totalResponseTime / totalRequests : 0;
    
    const errorRate = totalRequests > 0 ? 
      (this.metrics.totalErrors / totalRequests) * 100 : 0;

    return {
      cacheHits: this.metrics.cacheHits,
      cacheMisses: this.metrics.cacheMisses,
      cacheHitRate,
      averageResponseTime,
      activeConnections: this.connectionPool.size,
      totalRequests,
      errorRate
    };
  }

  /**
   * Get cache statistics
   */
  getCacheStatistics(): {
    totalEntries: number;
    totalSize: number;
    hitRate: number;
    oldestEntry: Date | null;
    newestEntry: Date | null;
    mostAccessedEntry: { key: string; accessCount: number } | null;
  } {
    let totalSize = 0;
    let oldestEntry: Date | null = null;
    let newestEntry: Date | null = null;
    let mostAccessedEntry: { key: string; accessCount: number } | null = null;

    for (const entry of this.cache.values()) {
      totalSize += entry.size;
      
      if (!oldestEntry || entry.timestamp < oldestEntry) {
        oldestEntry = entry.timestamp;
      }
      
      if (!newestEntry || entry.timestamp > newestEntry) {
        newestEntry = entry.timestamp;
      }
      
      if (!mostAccessedEntry || entry.accessCount > mostAccessedEntry.accessCount) {
        mostAccessedEntry = { key: entry.key, accessCount: entry.accessCount };
      }
    }

    const totalCacheRequests = this.metrics.cacheHits + this.metrics.cacheMisses;
    const hitRate = totalCacheRequests > 0 ? 
      (this.metrics.cacheHits / totalCacheRequests) * 100 : 0;

    return {
      totalEntries: this.cache.size,
      totalSize,
      hitRate,
      oldestEntry,
      newestEntry,
      mostAccessedEntry
    };
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    const entriesCleared = this.cache.size;
    this.cache.clear();
    console.log(`🗑️ Cache cleared: ${entriesCleared} entries removed`);
  }

  /**
   * Warm up cache with specific entries
   */
  async warmUpCache(
    requests: any[],
    executor: (request: any) => Promise<any>
  ): Promise<void> {
    console.log(`🔥 Warming up cache with ${requests.length} requests...`);
    
    const warmupPromises = requests.map(async (request) => {
      try {
        const cacheKey = this.generateCacheKey(request);
        if (!this.cache.has(cacheKey)) {
          const response = await executor(request);
          this.cacheResponse(cacheKey, response);
        }
      } catch (error) {
        console.error('Error warming up cache:', error);
      }
    });

    await Promise.allSettled(warmupPromises);
    console.log(`✅ Cache warm-up completed`);
  }

  /**
   * Optimize cache based on usage patterns
   */
  optimizeCache(): void {
    const stats = this.getCacheStatistics();
    
    // Remove entries that haven't been accessed recently
    const cutoffTime = Date.now() - (24 * 60 * 60 * 1000); // 24 hours ago
    let optimizedCount = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.lastAccessed.getTime() < cutoffTime && entry.accessCount < 2) {
        this.cache.delete(key);
        optimizedCount++;
      }
    }

    console.log(`🎯 Cache optimized: removed ${optimizedCount} underused entries`);
  }

  /**
   * Cleanup and destroy
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    this.cache.clear();
    this.connectionPool.clear();
    this.activeRequests.clear();
    
    console.log('🧹 Performance optimizer destroyed');
  }
}

// Global performance optimizer instance
let globalPerformanceOptimizer: PerformanceOptimizer | null = null;

export function getPerformanceOptimizer(): PerformanceOptimizer {
  if (!globalPerformanceOptimizer) {
    globalPerformanceOptimizer = new PerformanceOptimizer({
      maxSize: 50 * 1024 * 1024, // 50MB cache
      maxEntries: 500,
      defaultTTL: 10 * 60 * 1000, // 10 minutes
      cleanupInterval: 2 * 60 * 1000 // 2 minutes
    }, {
      maxConnections: 5,
      maxIdleTime: 60 * 1000, // 1 minute
      connectionTimeout: 15 * 1000, // 15 seconds
      retryAttempts: 2,
      retryDelay: 2000 // 2 seconds
    });
  }
  
  return globalPerformanceOptimizer;
}

export function resetPerformanceOptimizer(): void {
  if (globalPerformanceOptimizer) {
    globalPerformanceOptimizer.destroy();
    globalPerformanceOptimizer = null;
  }
}