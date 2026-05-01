/**
 * Memory Management System
 * Handles memory optimization, cleanup, and resource management for image editing
 */

export interface MemoryStats {
  totalAllocated: number;
  currentUsage: number;
  peakUsage: number;
  cacheSize: number;
  activeObjects: number;
}

export interface MemoryOptions {
  maxMemoryMB: number;
  cleanupThreshold: number; // 0-1, percentage of max memory
  aggressiveCleanup: boolean;
  enableMonitoring: boolean;
  cleanupInterval: number; // milliseconds
}

export interface ManagedResource {
  id: string;
  type: 'image' | 'canvas' | 'mask' | 'cache';
  size: number;
  lastAccessed: number;
  priority: number; // 1-10, higher = more important
  data: any;
  cleanup?: () => void;
}

export class MemoryManager {
  private options: MemoryOptions;
  private resources: Map<string, ManagedResource> = new Map();
  private stats: MemoryStats;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private observers: ((stats: MemoryStats) => void)[] = [];

  constructor(options: Partial<MemoryOptions> = {}) {
    this.options = {
      maxMemoryMB: 512,
      cleanupThreshold: 0.8,
      aggressiveCleanup: false,
      enableMonitoring: true,
      cleanupInterval: 30000, // 30 seconds
      ...options
    };

    this.stats = {
      totalAllocated: 0,
      currentUsage: 0,
      peakUsage: 0,
      cacheSize: 0,
      activeObjects: 0
    };

    if (this.options.enableMonitoring) {
      this.startMonitoring();
    }
  }

  /**
   * Register a resource for memory management
   */
  register(resource: Omit<ManagedResource, 'lastAccessed'>): string {
    const managedResource: ManagedResource = {
      ...resource,
      lastAccessed: Date.now()
    };

    this.resources.set(resource.id, managedResource);
    this.updateStats();

    // Check if cleanup is needed
    if (this.shouldCleanup()) {
      this.performCleanup();
    }

    return resource.id;
  }

  /**
   * Unregister a resource
   */
  unregister(id: string): boolean {
    const resource = this.resources.get(id);
    if (!resource) return false;

    // Call cleanup function if provided
    if (resource.cleanup) {
      try {
        resource.cleanup();
      } catch (error) {
        console.warn(`Cleanup failed for resource ${id}:`, error);
      }
    }

    this.resources.delete(id);
    this.updateStats();
    return true;
  }

  /**
   * Access a resource (updates last accessed time)
   */
  access(id: string): ManagedResource | null {
    const resource = this.resources.get(id);
    if (!resource) return null;

    resource.lastAccessed = Date.now();
    return resource;
  }

  /**
   * Update a resource's data
   */
  update(id: string, data: any, size?: number): boolean {
    const resource = this.resources.get(id);
    if (!resource) return false;

    resource.data = data;
    resource.lastAccessed = Date.now();
    
    if (size !== undefined) {
      resource.size = size;
    }

    this.updateStats();
    return true;
  }

  /**
   * Force cleanup of resources
   */
  performCleanup(aggressive = false): number {
    const targetUsage = this.options.maxMemoryMB * 1024 * 1024 * 
                       (aggressive ? 0.5 : this.options.cleanupThreshold);
    
    if (this.stats.currentUsage <= targetUsage) {
      return 0;
    }

    // Sort resources by cleanup priority (lower priority + older = first to clean)
    const sortedResources = Array.from(this.resources.values()).sort((a, b) => {
      const aPriority = a.priority + (Date.now() - a.lastAccessed) / 1000000;
      const bPriority = b.priority + (Date.now() - b.lastAccessed) / 1000000;
      return aPriority - bPriority;
    });

    let cleanedCount = 0;
    let currentUsage = this.stats.currentUsage;

    for (const resource of sortedResources) {
      if (currentUsage <= targetUsage) break;

      // Don't clean high priority resources unless aggressive
      if (!aggressive && resource.priority >= 8) continue;

      this.unregister(resource.id);
      currentUsage -= resource.size;
      cleanedCount++;
    }

    this.notifyObservers();
    return cleanedCount;
  }

  /**
   * Check if cleanup is needed
   */
  private shouldCleanup(): boolean {
    const maxBytes = this.options.maxMemoryMB * 1024 * 1024;
    const threshold = maxBytes * this.options.cleanupThreshold;
    return this.stats.currentUsage > threshold;
  }

  /**
   * Update memory statistics
   */
  private updateStats(): void {
    let totalSize = 0;
    let cacheSize = 0;

    this.resources.forEach(resource => {
      totalSize += resource.size;
      if (resource.type === 'cache') {
        cacheSize += resource.size;
      }
    });

    this.stats.currentUsage = totalSize;
    this.stats.cacheSize = cacheSize;
    this.stats.activeObjects = this.resources.size;

    if (totalSize > this.stats.peakUsage) {
      this.stats.peakUsage = totalSize;
    }

    this.stats.totalAllocated += totalSize;
  }

  /**
   * Start memory monitoring
   */
  private startMonitoring(): void {
    if (this.cleanupTimer) return;

    this.cleanupTimer = setInterval(() => {
      if (this.shouldCleanup()) {
        this.performCleanup(this.options.aggressiveCleanup);
      }
      this.notifyObservers();
    }, this.options.cleanupInterval);
  }

  /**
   * Stop memory monitoring
   */
  stopMonitoring(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Add memory stats observer
   */
  addObserver(callback: (stats: MemoryStats) => void): void {
    this.observers.push(callback);
  }

  /**
   * Remove memory stats observer
   */
  removeObserver(callback: (stats: MemoryStats) => void): void {
    const index = this.observers.indexOf(callback);
    if (index > -1) {
      this.observers.splice(index, 1);
    }
  }

  /**
   * Notify observers of stats changes
   */
  private notifyObservers(): void {
    this.observers.forEach(callback => {
      try {
        callback({ ...this.stats });
      } catch (error) {
        console.warn('Memory stats observer error:', error);
      }
    });
  }

  /**
   * Get current memory statistics
   */
  getStats(): MemoryStats {
    return { ...this.stats };
  }

  /**
   * Get resource information
   */
  getResource(id: string): ManagedResource | null {
    return this.resources.get(id) || null;
  }

  /**
   * Get all resources of a specific type
   */
  getResourcesByType(type: ManagedResource['type']): ManagedResource[] {
    return Array.from(this.resources.values()).filter(r => r.type === type);
  }

  /**
   * Clear all resources
   */
  clear(): void {
    const resourceIds = Array.from(this.resources.keys());
    resourceIds.forEach(id => this.unregister(id));
  }

  /**
   * Optimize memory usage
   */
  optimize(): {
    cleaned: number;
    compressed: number;
    cached: number;
  } {
    const result = {
      cleaned: 0,
      compressed: 0,
      cached: 0
    };

    // Clean up old resources
    result.cleaned = this.performCleanup();

    // Compress large resources
    this.resources.forEach(resource => {
      if (resource.type === 'image' && resource.size > 1024 * 1024) {
        // Attempt to compress large images
        if (this.compressResource(resource)) {
          result.compressed++;
        }
      }
    });

    // Cache frequently accessed resources
    const frequentResources = Array.from(this.resources.values())
      .filter(r => r.type !== 'cache')
      .sort((a, b) => b.lastAccessed - a.lastAccessed)
      .slice(0, 10);

    frequentResources.forEach(resource => {
      if (this.cacheResource(resource)) {
        result.cached++;
      }
    });

    return result;
  }

  /**
   * Compress a resource (placeholder implementation)
   */
  private compressResource(resource: ManagedResource): boolean {
    // This would implement actual compression logic
    // For now, just simulate compression
    if (resource.type === 'image' && typeof resource.data === 'string') {
      // Simulate 20% size reduction
      const originalSize = resource.size;
      resource.size = Math.floor(originalSize * 0.8);
      this.updateStats();
      return true;
    }
    return false;
  }

  /**
   * Cache a resource
   */
  private cacheResource(resource: ManagedResource): boolean {
    if (resource.type === 'cache') return false;

    const cacheId = `cache_${resource.id}`;
    if (this.resources.has(cacheId)) return false;

    this.register({
      id: cacheId,
      type: 'cache',
      size: resource.size,
      priority: Math.min(resource.priority + 1, 10),
      data: resource.data
    });

    return true;
  }

  /**
   * Get memory usage as percentage
   */
  getUsagePercentage(): number {
    const maxBytes = this.options.maxMemoryMB * 1024 * 1024;
    return (this.stats.currentUsage / maxBytes) * 100;
  }

  /**
   * Check if memory is critically low
   */
  isCriticalMemory(): boolean {
    return this.getUsagePercentage() > 90;
  }

  /**
   * Get memory recommendations
   */
  getRecommendations(): string[] {
    const recommendations: string[] = [];
    const usagePercent = this.getUsagePercentage();

    if (usagePercent > 80) {
      recommendations.push('Memory usage is high. Consider clearing unused resources.');
    }

    if (this.stats.cacheSize > this.stats.currentUsage * 0.5) {
      recommendations.push('Cache is using significant memory. Consider reducing cache size.');
    }

    if (this.stats.activeObjects > 100) {
      recommendations.push('Large number of active objects. Consider cleanup.');
    }

    const oldResources = Array.from(this.resources.values())
      .filter(r => Date.now() - r.lastAccessed > 300000); // 5 minutes

    if (oldResources.length > 10) {
      recommendations.push('Many old resources detected. Cleanup recommended.');
    }

    return recommendations;
  }

  /**
   * Destroy the memory manager
   */
  destroy(): void {
    this.stopMonitoring();
    this.clear();
    this.observers = [];
  }
}

// Global memory manager instance
let globalMemoryManager: MemoryManager | null = null;

/**
 * Get or create global memory manager
 */
export function getMemoryManager(options?: Partial<MemoryOptions>): MemoryManager {
  if (!globalMemoryManager) {
    globalMemoryManager = new MemoryManager(options);
  }
  return globalMemoryManager;
}

/**
 * Utility function to estimate object size
 */
export function estimateObjectSize(obj: any): number {
  if (obj === null || obj === undefined) return 0;
  
  if (typeof obj === 'string') {
    return obj.length * 2; // UTF-16 encoding
  }
  
  if (typeof obj === 'number') {
    return 8; // 64-bit number
  }
  
  if (typeof obj === 'boolean') {
    return 4;
  }
  
  if (obj instanceof ArrayBuffer) {
    return obj.byteLength;
  }
  
  if (obj instanceof ImageData) {
    return obj.data.length;
  }
  
  if (Array.isArray(obj)) {
    return obj.reduce((sum, item) => sum + estimateObjectSize(item), 0);
  }
  
  if (typeof obj === 'object') {
    return Object.keys(obj).reduce((sum, key) => {
      return sum + estimateObjectSize(key) + estimateObjectSize(obj[key]);
    }, 0);
  }
  
  return 0;
}

export default MemoryManager;