/**
 * Property-based tests for mask optimization
 * Tests universal properties for mask optimization efficiency
 */

import fc from 'fast-check';
import { MaskProcessor } from '../mask-processor';
import { Point, ImageSize, ProviderCapabilities } from '../types';

describe('Mask Optimization Properties', () => {
  const maskProcessor = new MaskProcessor();

  // Arbitraries for generating test data
  const arbitraryPoint = (): fc.Arbitrary<Point> =>
    fc.record({
      x: fc.integer({ min: 0, max: 1000 }),
      y: fc.integer({ min: 0, max: 1000 })
    });

  const arbitraryImageSize = (): fc.Arbitrary<ImageSize> =>
    fc.record({
      width: fc.integer({ min: 100, max: 2000 }),
      height: fc.integer({ min: 100, max: 2000 })
    });

  const arbitraryProviderCapabilities = (): fc.Arbitrary<ProviderCapabilities> =>
    fc.record({
      supportsNativeEditing: fc.boolean(),
      supportsBatchEditing: fc.boolean(),
      maxImageSize: arbitraryImageSize(),
      supportedMaskFormats: fc.constantFrom(['png'], ['base64'], ['png', 'base64']),
      highFidelitySupport: fc.boolean()
    });

  const arbitraryBrushCoordinates = (): fc.Arbitrary<Point[]> =>
    fc.array(arbitraryPoint(), { minLength: 1, maxLength: 50 });

  const arbitraryOpacity = (): fc.Arbitrary<number> =>
    fc.float({ min: Math.fround(0.1), max: Math.fround(1) });

  /**
   * Property 8: Mask Optimization Efficiency
   * **Validates: Requirements 6.1, 6.3, 6.5**
   * 
   * For any mask and provider combination, the mask should be optimized for the provider's 
   * requirements while preserving editing precision
   */
  test('Property 8: Mask Optimization Efficiency', () => {
    fc.assert(
      fc.property(
        fc.record({
          id: fc.string({ minLength: 1 }).filter(s => s.trim().length > 0),
          coordinates: arbitraryBrushCoordinates(),
          canvasSize: arbitraryImageSize(),
          opacity: arbitraryOpacity(),
          capabilities: arbitraryProviderCapabilities()
        }),
        ({ id, coordinates, canvasSize, opacity, capabilities }) => {
          // Create original mask
          const originalMask = maskProcessor.createMask(
            id,
            'brush',
            coordinates,
            canvasSize,
            opacity
          );

          // Optimize mask for provider
          const optimizedMask = maskProcessor.optimizeMask(
            originalMask,
            canvasSize,
            capabilities
          );

          // Property 1: Optimized mask should reference original
          expect(optimizedMask.originalMask).toBe(originalMask);

          // Property 2: Optimized data should be valid base64 or PNG
          expect(optimizedMask.optimizedData).toBeDefined();
          expect(typeof optimizedMask.optimizedData).toBe('string');
          expect(optimizedMask.optimizedData.length).toBeGreaterThan(0);

          // Property 3: Format should be one of the supported formats
          expect(['png', 'base64']).toContain(optimizedMask.format);
          if (capabilities.supportedMaskFormats.includes('png')) {
            expect(optimizedMask.format).toBe('png');
          } else {
            expect(optimizedMask.format).toBe('base64');
          }

          // Property 4: Resolution should respect provider limits
          expect(optimizedMask.resolution.width).toBeLessThanOrEqual(capabilities.maxImageSize.width);
          expect(optimizedMask.resolution.height).toBeLessThanOrEqual(capabilities.maxImageSize.height);

          // Property 5: Resolution should not exceed original size
          expect(optimizedMask.resolution.width).toBeLessThanOrEqual(canvasSize.width);
          expect(optimizedMask.resolution.height).toBeLessThanOrEqual(canvasSize.height);

          // Property 6: Compression ratio should be reasonable
          expect(optimizedMask.compressionRatio).toBeGreaterThan(0);
          expect(optimizedMask.compressionRatio).toBeLessThanOrEqual(10); // Reasonable upper bound

          // Property 7: If original size is within limits, resolution should match
          if (canvasSize.width <= capabilities.maxImageSize.width && 
              canvasSize.height <= capabilities.maxImageSize.height) {
            expect(optimizedMask.resolution.width).toBe(canvasSize.width);
            expect(optimizedMask.resolution.height).toBe(canvasSize.height);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property: Mask Encoding Consistency
   * For any mask and format, encoding should produce consistent results
   */
  test('Property: Mask Encoding Consistency', () => {
    fc.assert(
      fc.property(
        fc.record({
          id: fc.string({ minLength: 1 }).filter(s => s.trim().length > 0),
          coordinates: arbitraryBrushCoordinates(),
          canvasSize: arbitraryImageSize(),
          opacity: arbitraryOpacity(),
          // 🔧 FIX (2026-06-11 类型门禁): 显式字面量联合，constantFrom 默认推断为 string
          format: fc.constantFrom<'png' | 'base64'>('png', 'base64')
        }),
        ({ id, coordinates, canvasSize, opacity, format }) => {
          const mask = maskProcessor.createMask(
            id,
            'brush',
            coordinates,
            canvasSize,
            opacity
          );

          // Encode mask multiple times
          const encoded1 = maskProcessor.encodeMask(mask, format);
          const encoded2 = maskProcessor.encodeMask(mask, format);

          // Should produce identical results
          expect(encoded1).toBe(encoded2);

          // Should be valid string
          expect(typeof encoded1).toBe('string');
          expect(encoded1.length).toBeGreaterThan(0);

          // Format-specific validation
          if (format === 'png') {
            expect(encoded1).toMatch(/^data:image\/png;base64,/);
          } else {
            // base64 format should not have data URL prefix
            expect(encoded1).not.toMatch(/^data:/);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Property: Mask Simplification Preserves Bounds
   * For any brush mask, simplification should preserve the overall bounds
   */
  test('Property: Mask Simplification Preserves Bounds', () => {
    fc.assert(
      fc.property(
        fc.record({
          coordinates: fc.array(arbitraryPoint(), { minLength: 5, maxLength: 100 }),
          // 🔧 FIX (2026-06-11 G3): fast-check v3 的 fc.float 即使给了 min/max，默认
          // noNaN:false 仍会偶发生成 NaN（随机种子命中时 Math.max(NaN,1)=NaN，
          // toBeLessThanOrEqual(NaN) 恒假——本套件偶发红的根因）。容差语义本就
          // 不含 NaN，显式排除。
          tolerance: fc.float({ min: Math.fround(0.1), max: Math.fround(5.0), noNaN: true })
        }),
        ({ coordinates, tolerance }) => {
          const originalMask = maskProcessor.createMask(
            'test',
            'brush',
            coordinates,
            { width: 1000, height: 1000 },
            1.0
          );

          const simplifiedMask = maskProcessor.simplifyMask(originalMask, tolerance);

          // Simplified mask should have same or smaller coordinate count
          expect(simplifiedMask.coordinates.length).toBeLessThanOrEqual(originalMask.coordinates.length);

          // Should preserve essential properties
          expect(simplifiedMask.id).toBe(originalMask.id);
          expect(simplifiedMask.type).toBe(originalMask.type);
          expect(simplifiedMask.opacity).toBe(originalMask.opacity);

          // Bounds should be similar (within tolerance)
          const boundsToleranceX = Math.max(tolerance, 1);
          const boundsToleranceY = Math.max(tolerance, 1);
          
          expect(Math.abs(simplifiedMask.bounds.x - originalMask.bounds.x)).toBeLessThanOrEqual(boundsToleranceX);
          expect(Math.abs(simplifiedMask.bounds.y - originalMask.bounds.y)).toBeLessThanOrEqual(boundsToleranceY);
          expect(Math.abs(simplifiedMask.bounds.width - originalMask.bounds.width)).toBeLessThanOrEqual(boundsToleranceX * 2);
          expect(Math.abs(simplifiedMask.bounds.height - originalMask.bounds.height)).toBeLessThanOrEqual(boundsToleranceY * 2);

          // If coordinates are already minimal, should return unchanged
          if (originalMask.coordinates.length <= 2) {
            expect(simplifiedMask.coordinates).toEqual(originalMask.coordinates);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Property: Mask Scaling Preserves Proportions
   * For any mask and target size, scaling should preserve proportions
   */
  test('Property: Mask Scaling Preserves Proportions', () => {
    fc.assert(
      fc.property(
        fc.record({
          id: fc.string({ minLength: 1 }).filter(s => s.trim().length > 0),
          coordinates: arbitraryBrushCoordinates(),
          originalSize: arbitraryImageSize(),
          targetSize: arbitraryImageSize(),
          opacity: arbitraryOpacity()
        }),
        ({ id, coordinates, originalSize, targetSize, opacity }) => {
          const originalMask = maskProcessor.createMask(
            id,
            'brush',
            coordinates,
            originalSize,
            opacity
          );

          // Create capabilities that require scaling
          const capabilities: ProviderCapabilities = {
            supportsNativeEditing: true,
            supportsBatchEditing: false,
            maxImageSize: targetSize,
            supportedMaskFormats: ['base64'],
            highFidelitySupport: true
          };

          const optimizedMask = maskProcessor.optimizeMask(
            originalMask,
            originalSize,
            capabilities
          );

          // Calculate expected scale factors
          const scaleX = Math.min(targetSize.width / originalSize.width, 1);
          const scaleY = Math.min(targetSize.height / originalSize.height, 1);
          const scale = Math.min(scaleX, scaleY);

          const expectedWidth = Math.floor(originalSize.width * scale);
          const expectedHeight = Math.floor(originalSize.height * scale);

          // Resolution should match expected scaled size
          expect(optimizedMask.resolution.width).toBe(expectedWidth);
          expect(optimizedMask.resolution.height).toBe(expectedHeight);

          // Aspect ratio preservation depends on whether uniform scaling was applied
          // If both dimensions were scaled by the same factor, aspect ratio should be preserved
          if (Math.abs(scaleX - scaleY) < 0.001) {
            const originalAspect = originalSize.width / originalSize.height;
            const scaledAspect = optimizedMask.resolution.width / optimizedMask.resolution.height;
            
            // For uniform scaling, aspect ratio should be preserved (within rounding tolerance)
            const tolerance = 0.1;
            expect(Math.abs(originalAspect - scaledAspect)).toBeLessThan(tolerance);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Property: Optimal Format Selection
   * For any provider capabilities, format selection should prefer the best available option
   */
  test('Property: Optimal Format Selection', () => {
    fc.assert(
      fc.property(
        fc.record({
          id: fc.string({ minLength: 1 }).filter(s => s.trim().length > 0),
          coordinates: arbitraryBrushCoordinates(),
          canvasSize: arbitraryImageSize(),
          opacity: arbitraryOpacity(),
          supportedFormats: fc.subarray(['png', 'base64'], { minLength: 1 })
        }),
        ({ id, coordinates, canvasSize, opacity, supportedFormats }) => {
          const mask = maskProcessor.createMask(
            id,
            'brush',
            coordinates,
            canvasSize,
            opacity
          );

          const capabilities: ProviderCapabilities = {
            supportsNativeEditing: true,
            supportsBatchEditing: false,
            maxImageSize: { width: 2000, height: 2000 },
            supportedMaskFormats: supportedFormats,
            highFidelitySupport: true
          };

          const optimizedMask = maskProcessor.optimizeMask(
            mask,
            canvasSize,
            capabilities
          );

          // Should select PNG if available (preferred format)
          if (supportedFormats.includes('png')) {
            expect(optimizedMask.format).toBe('png');
          } else {
            expect(optimizedMask.format).toBe('base64');
          }

          // Selected format should be in supported formats
          expect(supportedFormats).toContain(optimizedMask.format);
        }
      ),
      { numRuns: 50 }
    );
  });
});