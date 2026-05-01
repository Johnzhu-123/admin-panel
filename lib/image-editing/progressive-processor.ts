/**
 * Progressive Loading and Processing System
 * Handles large images with tiling strategies, progressive loading, and memory management
 */

import { Mask, ImageSize, OptimizationOptions, PerformanceMetrics } from './types';

export interface TileInfo {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  originalX: number;
  originalY: number;
  data?: string; // base64 image data for this tile
}

export interface ProcessingProgress {
  totalTiles: number;
  processedTiles: number;
  currentTile: string | null;
  estimatedTimeRemaining: number;
  memoryUsage: number;
}

export interface ProgressiveOptions {
  maxTileSize: number;
  maxMemoryUsage: number; // in MB
  enableProgressiveLoading: boolean;
  tileOverlap: number; // pixels of overlap between tiles
  qualityLevel: 'low' | 'medium' | 'high';
  enableCaching: boolean;
}

export class ProgressiveProcessor {
  private options: ProgressiveOptions;
  private tileCache: Map<string, TileInfo> = new Map();
  private processingQueue: TileInfo[] = [];
  private currentMemoryUsage = 0;
  private metrics: PerformanceMetrics;
  private abortController: AbortController | null = null;

  constructor(options: Partial<ProgressiveOptions> = {}) {
    this.options = {
      maxTileSize: 1024,
      maxMemoryUsage: 512, // 512MB
      enableProgressiveLoading: true,
      tileOverlap: 32,
      qualityLevel: 'medium',
      enableCaching: true,
      ...options
    };

    this.metrics = {
      processingTime: 0,
      memoryUsage: 0,
      apiCalls: 0,
      cacheHits: 0,
      cacheMisses: 0
    };
  }

  /**
   * Process a large image progressively by breaking it into tiles
   */
  async processImageProgressively(
    imageData: string,
    masks: Mask[],
    onProgress?: (progress: ProcessingProgress) => void,
    onTileComplete?: (tile: TileInfo, result: string) => void
  ): Promise<string> {
    const startTime = Date.now();
    this.abortController = new AbortController();

    try {
      // Load and analyze the image
      const imageInfo = await this.analyzeImage(imageData);
      
      // Determine if tiling is necessary
      if (!this.needsTiling(imageInfo)) {
        return this.processImageDirect(imageData, masks);
      }

      // Create tiles
      const tiles = this.createTiles(imageInfo, masks);
      this.processingQueue = [...tiles];

      // Process tiles progressively
      const processedTiles: Map<string, string> = new Map();
      let processedCount = 0;

      for (const tile of tiles) {
        if (this.abortController.signal.aborted) {
          throw new Error('Processing aborted');
        }

        // Check memory usage
        await this.manageMemory();

        // Process tile
        const result = await this.processTile(tile, imageData, masks);
        processedTiles.set(tile.id, result);
        processedCount++;

        // Update progress
        if (onProgress) {
          const progress: ProcessingProgress = {
            totalTiles: tiles.length,
            processedTiles: processedCount,
            currentTile: tile.id,
            estimatedTimeRemaining: this.estimateRemainingTime(
              startTime,
              processedCount,
              tiles.length
            ),
            memoryUsage: this.currentMemoryUsage
          };
          onProgress(progress);
        }

        // Notify tile completion
        if (onTileComplete) {
          onTileComplete(tile, result);
        }

        // Yield control to prevent blocking
        await this.yieldControl();
      }

      // Reassemble tiles into final image
      const finalImage = await this.reassembleTiles(tiles, processedTiles, imageInfo);

      // Update metrics
      this.metrics.processingTime = Date.now() - startTime;
      this.metrics.memoryUsage = this.currentMemoryUsage;

      return finalImage;

    } catch (error) {
      console.error('Progressive processing failed:', error);
      throw error;
    } finally {
      this.cleanup();
    }
  }

  /**
   * Analyze image to determine processing strategy
   */
  private async analyzeImage(imageData: string): Promise<ImageSize & { format: string }> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        resolve({
          width: img.width,
          height: img.height,
          format: this.detectImageFormat(imageData)
        });
      };
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = imageData;
    });
  }

  /**
   * Determine if image needs tiling based on size and memory constraints
   */
  private needsTiling(imageInfo: ImageSize): boolean {
    const imageArea = imageInfo.width * imageInfo.height;
    const maxTileArea = this.options.maxTileSize * this.options.maxTileSize;
    
    // Estimate memory usage (4 bytes per pixel for RGBA)
    const estimatedMemoryMB = (imageArea * 4) / (1024 * 1024);
    
    return imageArea > maxTileArea || estimatedMemoryMB > this.options.maxMemoryUsage / 4;
  }

  /**
   * Create tiles for progressive processing
   */
  private createTiles(imageInfo: ImageSize, masks: Mask[]): TileInfo[] {
    const tiles: TileInfo[] = [];
    const tileSize = this.options.maxTileSize;
    const overlap = this.options.tileOverlap;

    let tileId = 0;
    for (let y = 0; y < imageInfo.height; y += tileSize - overlap) {
      for (let x = 0; x < imageInfo.width; x += tileSize - overlap) {
        const width = Math.min(tileSize, imageInfo.width - x);
        const height = Math.min(tileSize, imageInfo.height - y);

        // Only create tile if it intersects with any mask
        if (this.tileIntersectsMasks(x, y, width, height, masks)) {
          tiles.push({
            id: `tile_${tileId++}`,
            x,
            y,
            width,
            height,
            originalX: x,
            originalY: y
          });
        }
      }
    }

    return tiles;
  }

  /**
   * Check if a tile intersects with any mask
   */
  private tileIntersectsMasks(x: number, y: number, width: number, height: number, masks: Mask[]): boolean {
    const tileRect = { x, y, width, height };
    
    return masks.some(mask => {
      const maskRect = mask.bounds;
      return !(
        tileRect.x + tileRect.width < maskRect.x ||
        maskRect.x + maskRect.width < tileRect.x ||
        tileRect.y + tileRect.height < maskRect.y ||
        maskRect.y + maskRect.height < tileRect.y
      );
    });
  }

  /**
   * Process a single tile
   */
  private async processTile(tile: TileInfo, originalImage: string, masks: Mask[]): Promise<string> {
    // Check cache first
    if (this.options.enableCaching) {
      const cacheKey = this.generateCacheKey(tile, masks);
      const cached = this.tileCache.get(cacheKey);
      if (cached?.data) {
        this.metrics.cacheHits++;
        return cached.data;
      }
      this.metrics.cacheMisses++;
    }

    // Extract tile from original image
    const tileImage = await this.extractTile(originalImage, tile);
    
    // Filter masks that intersect with this tile
    const relevantMasks = this.filterMasksForTile(masks, tile);
    
    // Process tile (this would call the actual editing API)
    const processedTile = await this.processImageDirect(tileImage, relevantMasks);
    
    // Cache result
    if (this.options.enableCaching) {
      const cacheKey = this.generateCacheKey(tile, masks);
      this.tileCache.set(cacheKey, { ...tile, data: processedTile });
    }

    // Update memory usage
    this.updateMemoryUsage(processedTile);

    return processedTile;
  }

  /**
   * Extract a tile from the original image
   */
  private async extractTile(imageData: string, tile: TileInfo): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = tile.width;
        canvas.height = tile.height;
        
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Failed to get canvas context'));
          return;
        }

        // Draw the tile portion of the image
        ctx.drawImage(
          img,
          tile.x, tile.y, tile.width, tile.height,
          0, 0, tile.width, tile.height
        );

        resolve(canvas.toDataURL());
      };
      img.onerror = () => reject(new Error('Failed to load image for tile extraction'));
      img.src = imageData;
    });
  }

  /**
   * Filter masks to only those relevant for a specific tile
   */
  private filterMasksForTile(masks: Mask[], tile: TileInfo): Mask[] {
    return masks.filter(mask => {
      // Check if mask intersects with tile
      const maskRect = mask.bounds;
      const tileRect = { x: tile.x, y: tile.y, width: tile.width, height: tile.height };
      
      const intersects = !(
        tileRect.x + tileRect.width < maskRect.x ||
        maskRect.x + maskRect.width < tileRect.x ||
        tileRect.y + tileRect.height < maskRect.y ||
        maskRect.y + maskRect.height < tileRect.y
      );

      if (!intersects) return false;

      // Adjust mask coordinates relative to tile
      const adjustedMask: Mask = {
        ...mask,
        coordinates: mask.coordinates.map(coord => ({
          x: coord.x - tile.x,
          y: coord.y - tile.y
        })),
        bounds: {
          x: Math.max(0, maskRect.x - tile.x),
          y: Math.max(0, maskRect.y - tile.y),
          width: Math.min(tile.width, maskRect.x + maskRect.width - tile.x) - Math.max(0, maskRect.x - tile.x),
          height: Math.min(tile.height, maskRect.y + maskRect.height - tile.y) - Math.max(0, maskRect.y - tile.y)
        }
      };

      return adjustedMask;
    }).map(mask => {
      // Return adjusted mask
      const maskRect = mask.bounds;
      return {
        ...mask,
        coordinates: mask.coordinates.map(coord => ({
          x: coord.x - tile.x,
          y: coord.y - tile.y
        })),
        bounds: {
          x: Math.max(0, maskRect.x - tile.x),
          y: Math.max(0, maskRect.y - tile.y),
          width: Math.min(tile.width, maskRect.x + maskRect.width - tile.x) - Math.max(0, maskRect.x - tile.x),
          height: Math.min(tile.height, maskRect.y + maskRect.height - tile.y) - Math.max(0, maskRect.y - tile.y)
        }
      };
    });
  }

  /**
   * Reassemble processed tiles into final image
   */
  private async reassembleTiles(
    tiles: TileInfo[],
    processedTiles: Map<string, string>,
    imageInfo: ImageSize & { format: string }
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const canvas = document.createElement('canvas');
      canvas.width = imageInfo.width;
      canvas.height = imageInfo.height;
      
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Failed to get canvas context for reassembly'));
        return;
      }

      let loadedTiles = 0;
      const totalTiles = tiles.length;

      if (totalTiles === 0) {
        resolve(canvas.toDataURL());
        return;
      }

      tiles.forEach(tile => {
        const tileData = processedTiles.get(tile.id);
        if (!tileData) {
          console.warn(`Missing data for tile ${tile.id}`);
          loadedTiles++;
          if (loadedTiles === totalTiles) {
            resolve(canvas.toDataURL());
          }
          return;
        }

        const img = new Image();
        img.onload = () => {
          // Handle overlap by using composite operations
          ctx.globalCompositeOperation = 'source-over';
          ctx.drawImage(img, tile.x, tile.y);
          
          loadedTiles++;
          if (loadedTiles === totalTiles) {
            resolve(canvas.toDataURL());
          }
        };
        img.onerror = () => {
          console.error(`Failed to load tile ${tile.id}`);
          loadedTiles++;
          if (loadedTiles === totalTiles) {
            resolve(canvas.toDataURL());
          }
        };
        img.src = tileData;
      });
    });
  }

  /**
   * Process image directly without tiling (for smaller images)
   */
  private async processImageDirect(imageData: string, masks: Mask[]): Promise<string> {
    // This would integrate with the actual image editing API
    // For now, return the original image as a placeholder
    this.metrics.apiCalls++;
    return imageData;
  }

  /**
   * Memory management
   */
  private async manageMemory(): Promise<void> {
    const memoryUsageMB = this.currentMemoryUsage / (1024 * 1024);
    
    if (memoryUsageMB > this.options.maxMemoryUsage * 0.8) {
      // Clear oldest cache entries
      const cacheEntries = Array.from(this.tileCache.entries());
      const entriesToRemove = Math.ceil(cacheEntries.length * 0.3);
      
      for (let i = 0; i < entriesToRemove; i++) {
        this.tileCache.delete(cacheEntries[i][0]);
      }

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      // Update memory usage
      this.currentMemoryUsage = this.estimateMemoryUsage();
    }
  }

  /**
   * Estimate current memory usage
   */
  private estimateMemoryUsage(): number {
    let totalSize = 0;
    
    this.tileCache.forEach(tile => {
      if (tile.data) {
        // Rough estimate: base64 string length * 0.75 (base64 overhead)
        totalSize += tile.data.length * 0.75;
      }
    });

    return totalSize;
  }

  /**
   * Update memory usage tracking
   */
  private updateMemoryUsage(data: string): void {
    this.currentMemoryUsage += data.length * 0.75;
  }

  /**
   * Generate cache key for a tile
   */
  private generateCacheKey(tile: TileInfo, masks: Mask[]): string {
    const maskHashes = masks.map(mask => 
      `${mask.id}_${mask.bounds.x}_${mask.bounds.y}_${mask.bounds.width}_${mask.bounds.height}`
    ).join('|');
    
    return `${tile.x}_${tile.y}_${tile.width}_${tile.height}_${maskHashes}`;
  }

  /**
   * Detect image format from data URL
   */
  private detectImageFormat(imageData: string): string {
    if (imageData.startsWith('data:image/png')) return 'png';
    if (imageData.startsWith('data:image/jpeg')) return 'jpeg';
    if (imageData.startsWith('data:image/webp')) return 'webp';
    return 'unknown';
  }

  /**
   * Estimate remaining processing time
   */
  private estimateRemainingTime(startTime: number, processed: number, total: number): number {
    if (processed === 0) return 0;
    
    const elapsed = Date.now() - startTime;
    const avgTimePerTile = elapsed / processed;
    const remaining = total - processed;
    
    return remaining * avgTimePerTile;
  }

  /**
   * Yield control to prevent blocking the main thread
   */
  private async yieldControl(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    this.abortController = null;
    
    // Clear cache if not persistent
    if (!this.options.enableCaching) {
      this.tileCache.clear();
    }
    
    this.processingQueue = [];
  }

  /**
   * Abort current processing
   */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  /**
   * Get current performance metrics
   */
  getMetrics(): PerformanceMetrics {
    return { ...this.metrics };
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.tileCache.clear();
    this.currentMemoryUsage = 0;
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; memoryUsage: number; hitRate: number } {
    const totalRequests = this.metrics.cacheHits + this.metrics.cacheMisses;
    const hitRate = totalRequests > 0 ? this.metrics.cacheHits / totalRequests : 0;
    
    return {
      size: this.tileCache.size,
      memoryUsage: this.currentMemoryUsage,
      hitRate
    };
  }
}

export default ProgressiveProcessor;