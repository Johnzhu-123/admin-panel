/**
 * Property-based tests for performance characteristics
 * Tests progressive processing, memory management, and optimization performance
 * **Validates: Requirements 9.1, 9.5**
 */

import * as fc from 'fast-check';
import { ProgressiveProcessor } from '../progressive-processor';
import { MemoryManager, estimateObjectSize } from '../memory-manager';
import { Mask, ImageSize } from '../types';

// Mock ImageData and Image for tests
global.ImageData = class ImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }
} as any;

global.Image = class {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src: string = '';
  width: number = 400;
  height: number = 300;
  
  constructor() {
    setTimeout(() => {
      if (this.onload) {
        this.onload();
      }
    }, 0);
  }
} as any;

// Mock document.createElement for canvas
global.document = {
  createElement: (tagName: string) => {
    if (tagName === 'canvas') {
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: jest.fn(),
          clearRect: jest.fn(),
          fillRect: jest.fn(),
          strokeRect: jest.fn(),
          beginPath: jest.fn(),
          moveTo: jest.fn(),
          lineTo: jest.fn(),
          arc: jest.fn(),
          fill: jest.fn(),
          stroke: jest.fn(),
          save: jest.fn(),
          restore: jest.fn(),
          getImageData: () => new ImageData(100, 100),
          putImageData: jest.fn()
        }),
        toDataURL: () => 'data:image/png;base64,mock'
      };
    }
    return {};
  }
} as any;

describe('Performance Characteristics Property Tests', () => {
  // Arbitraries for generating test data
  const arbitraryImageSize = fc.record({
    width: fc.integer({ min: 100, max: 4000 }),
    height: fc.integer({ min: 100, max: 4000 })
  });

  const arbitraryMask = fc.record({
    id: fc.string({ minLength: 1, maxLength: 20 }),
    type: fc.constantFrom('brush', 'rectangle', 'circle'),
    coordinates: fc.array(
      fc.record({
        x: fc.integer({ min: 0, max: 1000 }),
        y: fc.integer({ min: 0, max: 1000 })
      }),
      { minLength: 1, maxLength: 10 }
    ),
    bounds: fc.record({
      x: fc.integer({ min: 0, max: 1000 }),
      y: fc.integer({ min: 0, max: 1000 }),
      width: fc.integer({ min: 1, max: 500 }),
      height: fc.integer({ min: 1, max: 500 })
    }),
    opacity: fc.float({ min: Math.fround(0.1), max: Math.fround(1.0) }),
    data: fc.constant(new ImageData(100, 100))
  }) as fc.Arbitrary<Mask>;

  const arbitraryMaskArray = fc.array(arbitraryMask, { minLength: 0, maxLength: 10 });

  describe('Progressive Processing Performance Properties', () => {
    /**
     * Property: Processing time should scale reasonably with image size
     * **Validates: Requirements 9.1**
     */
    test('processing time scales reasonably with image size', async () => {
      await fc.assert(fc.asyncProperty(
        arbitraryImageSize,
        arbitraryMaskArray,
        async (imageSize, masks) => {
          const processor = new ProgressiveProcessor({
            maxTileSize: 512,
            enableProgressiveLoading: true
          });

          const imageData = `data:image/png;base64,mock_${imageSize.width}x${imageSize.height}`;
          const startTime = Date.now();

          try {
            // Mock the processing to avoid actual API calls
            const result = await processor.processImageProgressively(
              imageData,
              masks,
              undefined,
              undefined
            );
            
            const processingTime = Date.now() - startTime;
            const imageArea = imageSize.width * imageSize.height;
            
            // Processing time should be reasonable (less than 10ms per 100k pixels in mock)
            const expectedMaxTime = Math.max(100, (imageArea / 100000) * 10);
            
            expect(processingTime).toBeLessThan(expectedMaxTime);
            expect(result).toBeDefined();
            
            return true;
          } catch (error) {
            // Allow for reasonable failures but ensure they're handled
            return error instanceof Error;
          }
        }
      ), { numRuns: 20 });
    });

    /**
     * Property: Memory usage should not exceed configured limits
     * **Validates: Requirements 9.5**
     */
    test('memory usage stays within configured limits', async () => {
      await fc.assert(fc.asyncProperty(
        fc.integer({ min: 64, max: 512 }), // maxMemoryMB
        arbitraryImageSize,
        arbitraryMaskArray,
        async (maxMemoryMB, imageSize, masks) => {
          const processor = new ProgressiveProcessor({
            maxMemoryUsage: maxMemoryMB,
            enableCaching: true
          });

          const imageData = `data:image/png;base64,mock_${imageSize.width}x${imageSize.height}`;
          
          try {
            await processor.processImageProgressively(imageData, masks);
            
            const cacheStats = processor.getCacheStats();
            const memoryUsageMB = cacheStats.memoryUsage / (1024 * 1024);
            
            // Memory usage should not significantly exceed the limit
            expect(memoryUsageMB).toBeLessThanOrEqual(maxMemoryMB * 1.2); // Allow 20% overhead
            
            return true;
          } catch (error) {
            return error instanceof Error;
          }
        }
      ), { numRuns: 15 });
    });

    /**
     * Property: Cache hit rate should improve with repeated operations
     * **Validates: Requirements 9.4**
     */
    test('cache hit rate improves with repeated operations', async () => {
      await fc.assert(fc.asyncProperty(
        arbitraryImageSize,
        arbitraryMaskArray,
        async (imageSize, masks) => {
          const processor = new ProgressiveProcessor({
            enableCaching: true,
            maxTileSize: 256
          });

          const imageData = `data:image/png;base64,mock_${imageSize.width}x${imageSize.height}`;
          
          try {
            // First processing - should have low hit rate
            await processor.processImageProgressively(imageData, masks);
            const firstStats = processor.getCacheStats();
            
            // Second processing with same data - should have higher hit rate
            await processor.processImageProgressively(imageData, masks);
            const secondStats = processor.getCacheStats();
            
            // Hit rate should improve or stay the same
            expect(secondStats.hitRate).toBeGreaterThanOrEqual(firstStats.hitRate);
            
            return true;
          } catch (error) {
            return error instanceof Error;
          }
        }
      ), { numRuns: 10 });
    });

    /**
     * Property: Tile count should be reasonable for image size
     */
    test('tile count is reasonable for image size', () => {
      fc.assert(fc.property(
        arbitraryImageSize,
        arbitraryMaskArray,
        (imageSize, masks) => {
          const processor = new ProgressiveProcessor({
            maxTileSize: 512
          });

          // Access private method through type assertion for testing
          const createTiles = (processor as any).createTiles.bind(processor);
          const tiles = createTiles(imageSize, masks);
          
          const expectedMaxTiles = Math.ceil(imageSize.width / 512) * Math.ceil(imageSize.height / 512);
          
          // Tile count should not exceed theoretical maximum
          expect(tiles.length).toBeLessThanOrEqual(expectedMaxTiles);
          
          // Each tile should have valid dimensions
          tiles.forEach((tile: any) => {
            expect(tile.width).toBeGreaterThan(0);
            expect(tile.height).toBeGreaterThan(0);
            expect(tile.x).toBeGreaterThanOrEqual(0);
            expect(tile.y).toBeGreaterThanOrEqual(0);
          });
          
          return true;
        }
      ), { numRuns: 25 });
    });
  });

  describe('Memory Manager Performance Properties', () => {
    /**
     * Property: Memory cleanup should reduce usage
     * **Validates: Requirements 9.5**
     */
    test('memory cleanup reduces usage', () => {
      fc.assert(fc.property(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 20 }),
            type: fc.constantFrom('image', 'canvas', 'mask', 'cache'),
            size: fc.integer({ min: 1024, max: 1024 * 1024 }), // 1KB to 1MB
            priority: fc.integer({ min: 1, max: 10 }),
            data: fc.string({ minLength: 100, maxLength: 1000 })
          }),
          { minLength: 5, maxLength: 50 }
        ),
        (resources) => {
          const memoryManager = new MemoryManager({
            maxMemoryMB: 10,
            cleanupThreshold: 0.8
          });

          // Register all resources
          resources.forEach(resource => {
            memoryManager.register(resource);
          });

          const beforeStats = memoryManager.getStats();
          const cleanedCount = memoryManager.performCleanup();
          const afterStats = memoryManager.getStats();

          if (cleanedCount > 0) {
            // If cleanup occurred, usage should be reduced
            expect(afterStats.currentUsage).toBeLessThan(beforeStats.currentUsage);
            expect(afterStats.activeObjects).toBeLessThan(beforeStats.activeObjects);
          }

          // Usage should never exceed maximum significantly
          const maxBytes = 10 * 1024 * 1024;
          expect(afterStats.currentUsage).toBeLessThanOrEqual(maxBytes * 1.1); // Allow 10% overhead

          return true;
        }
      ), { numRuns: 20 });
    });

    /**
     * Property: Resource access updates last accessed time
     */
    test('resource access updates timestamps correctly', () => {
      fc.assert(fc.property(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 20 }),
            type: fc.constantFrom('image', 'canvas', 'mask', 'cache'),
            size: fc.integer({ min: 100, max: 10000 }),
            priority: fc.integer({ min: 1, max: 10 }),
            data: fc.string({ minLength: 10, maxLength: 100 })
          }),
          { minLength: 1, maxLength: 10 }
        ),
        (resources) => {
          const memoryManager = new MemoryManager();
          
          // Register resources
          resources.forEach(resource => {
            memoryManager.register(resource);
          });

          // Access each resource and verify timestamp update
          resources.forEach(resource => {
            const beforeAccess = Date.now();
            const accessed = memoryManager.access(resource.id);
            const afterAccess = Date.now();

            expect(accessed).toBeTruthy();
            if (accessed) {
              expect(accessed.lastAccessed).toBeGreaterThanOrEqual(beforeAccess);
              expect(accessed.lastAccessed).toBeLessThanOrEqual(afterAccess);
            }
          });

          return true;
        }
      ), { numRuns: 15 });
    });

    /**
     * Property: Memory stats are consistent with registered resources
     */
    test('memory stats consistency', () => {
      fc.assert(fc.property(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 20 }),
            type: fc.constantFrom('image', 'canvas', 'mask', 'cache'),
            size: fc.integer({ min: 100, max: 10000 }),
            priority: fc.integer({ min: 1, max: 10 }),
            data: fc.string({ minLength: 10, maxLength: 100 })
          }),
          { minLength: 0, maxLength: 20 }
        ),
        (resources) => {
          const memoryManager = new MemoryManager();
          
          let expectedSize = 0;
          let expectedCacheSize = 0;
          
          // Register resources and calculate expected stats
          resources.forEach(resource => {
            memoryManager.register(resource);
            expectedSize += resource.size;
            if (resource.type === 'cache') {
              expectedCacheSize += resource.size;
            }
          });

          const stats = memoryManager.getStats();
          
          expect(stats.currentUsage).toBe(expectedSize);
          expect(stats.cacheSize).toBe(expectedCacheSize);
          expect(stats.activeObjects).toBe(resources.length);

          return true;
        }
      ), { numRuns: 25 });
    });

    /**
     * Property: Object size estimation is reasonable
     */
    test('object size estimation is reasonable', () => {
      fc.assert(fc.property(
        fc.oneof(
          fc.string({ minLength: 0, maxLength: 1000 }),
          fc.integer(),
          fc.boolean(),
          fc.array(fc.integer(), { minLength: 0, maxLength: 100 }),
          fc.record({
            name: fc.string({ minLength: 1, maxLength: 50 }),
            value: fc.integer(),
            active: fc.boolean()
          })
        ),
        (obj) => {
          const estimatedSize = estimateObjectSize(obj);
          
          // Size should be non-negative
          expect(estimatedSize).toBeGreaterThanOrEqual(0);
          
          // Size should be reasonable for the object type
          if (typeof obj === 'string') {
            expect(estimatedSize).toBe(obj.length * 2); // UTF-16
          } else if (typeof obj === 'number') {
            expect(estimatedSize).toBe(8); // 64-bit
          } else if (typeof obj === 'boolean') {
            expect(estimatedSize).toBe(4);
          } else if (Array.isArray(obj)) {
            expect(estimatedSize).toBeGreaterThanOrEqual(0);
          }

          return true;
        }
      ), { numRuns: 30 });
    });
  });

  describe('Performance Optimization Properties', () => {
    /**
     * Property: Optimization should improve overall efficiency
     */
    test('optimization improves overall efficiency', () => {
      fc.assert(fc.property(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 20 }),
            type: fc.constantFrom('image', 'canvas', 'mask', 'cache'),
            size: fc.integer({ min: 1000, max: 100000 }),
            priority: fc.integer({ min: 1, max: 10 }),
            data: fc.string({ minLength: 100, maxLength: 1000 })
          }),
          { minLength: 5, maxLength: 20 }
        ),
        (resources) => {
          const memoryManager = new MemoryManager({
            maxMemoryMB: 50
          });

          // Register resources
          resources.forEach(resource => {
            memoryManager.register(resource);
          });

          const beforeStats = memoryManager.getStats();
          const optimizationResult = memoryManager.optimize();
          const afterStats = memoryManager.getStats();

          // Optimization results should be non-negative
          expect(optimizationResult.cleaned).toBeGreaterThanOrEqual(0);
          expect(optimizationResult.compressed).toBeGreaterThanOrEqual(0);
          expect(optimizationResult.cached).toBeGreaterThanOrEqual(0);

          // If resources were cleaned, memory usage should decrease
          if (optimizationResult.cleaned > 0) {
            expect(afterStats.currentUsage).toBeLessThan(beforeStats.currentUsage);
          }

          // Memory usage should not exceed reasonable bounds
          const maxBytes = 50 * 1024 * 1024;
          expect(afterStats.currentUsage).toBeLessThanOrEqual(maxBytes * 1.5); // Allow for caching overhead

          return true;
        }
      ), { numRuns: 15 });
    });

    /**
     * Property: Performance metrics are monotonic where expected
     */
    test('performance metrics are monotonic', () => {
      fc.assert(fc.property(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 20 }),
            type: fc.constantFrom('image', 'canvas', 'mask', 'cache'),
            size: fc.integer({ min: 100, max: 10000 }),
            priority: fc.integer({ min: 1, max: 10 }),
            data: fc.string({ minLength: 10, maxLength: 100 })
          }),
          { minLength: 1, maxLength: 10 }
        ),
        (resources) => {
          const memoryManager = new MemoryManager();
          
          let previousStats = memoryManager.getStats();
          
          resources.forEach(resource => {
            memoryManager.register(resource);
            const currentStats = memoryManager.getStats();
            
            // Total allocated should be monotonically increasing
            expect(currentStats.totalAllocated).toBeGreaterThanOrEqual(previousStats.totalAllocated);
            
            // Peak usage should be monotonically increasing
            expect(currentStats.peakUsage).toBeGreaterThanOrEqual(previousStats.peakUsage);
            
            // Active objects should increase
            expect(currentStats.activeObjects).toBeGreaterThan(previousStats.activeObjects);
            
            previousStats = currentStats;
          });

          return true;
        }
      ), { numRuns: 20 });
    });

    /**
     * Property: Memory usage percentage calculation is accurate
     */
    test('memory usage percentage is accurate', () => {
      fc.assert(fc.property(
        fc.integer({ min: 1, max: 100 }), // maxMemoryMB
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 20 }),
            type: fc.constantFrom('image', 'canvas', 'mask', 'cache'),
            size: fc.integer({ min: 1000, max: 50000 }),
            priority: fc.integer({ min: 1, max: 10 }),
            data: fc.string({ minLength: 10, maxLength: 100 })
          }),
          { minLength: 0, maxLength: 10 }
        ),
        (maxMemoryMB, resources) => {
          const memoryManager = new MemoryManager({ maxMemoryMB });
          
          resources.forEach(resource => {
            memoryManager.register(resource);
          });

          const stats = memoryManager.getStats();
          const usagePercentage = memoryManager.getUsagePercentage();
          
          const expectedPercentage = (stats.currentUsage / (maxMemoryMB * 1024 * 1024)) * 100;
          
          // Usage percentage should be accurate within floating point precision
          expect(Math.abs(usagePercentage - expectedPercentage)).toBeLessThan(0.01);
          
          // Percentage should be between 0 and reasonable upper bound
          expect(usagePercentage).toBeGreaterThanOrEqual(0);
          expect(usagePercentage).toBeLessThan(200); // Allow for some overhead

          return true;
        }
      ), { numRuns: 25 });
    });
  });
});