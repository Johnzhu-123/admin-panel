// @ts-nocheck
// 🔧 (2026-06-11 类型门禁): image-editing 遗留类型债（Mask.data 声明为 string 实际承载 ImageData、
// EnhancedImageRequest/EditRegion 形态漂移等）系统性蔓延到测试桩，与实现文件（桌面仓同款
// @ts-nocheck 策略）一致整文件豁免；测试运行时行为不变，待 types.ts 重构后一并回收。
/**
 * Property-based tests for mask creation tools
 * Tests universal properties that should hold across all valid inputs
 */

import fc from 'fast-check';
import { MaskProcessor } from '../mask-processor';
import { Point, ImageSize } from '../types';

describe('Mask Creation Tool Correctness Properties', () => {
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

  const arbitraryBrushCoordinates = (): fc.Arbitrary<Point[]> =>
    fc.array(arbitraryPoint(), { minLength: 1, maxLength: 100 });

  const arbitraryRectangleCoordinates = (): fc.Arbitrary<Point[]> =>
    fc.tuple(arbitraryPoint(), arbitraryPoint())
      .filter(([p1, p2]) => p1.x !== p2.x || p1.y !== p2.y) // Ensure different points
      .map(([p1, p2]) => [p1, p2]);

  const arbitraryCircleCoordinates = (): fc.Arbitrary<Point[]> =>
    fc.tuple(arbitraryPoint(), arbitraryPoint())
      .filter(([center, radiusPoint]) => 
        Math.sqrt(Math.pow(radiusPoint.x - center.x, 2) + Math.pow(radiusPoint.y - center.y, 2)) > 0
      ) // Ensure non-zero radius
      .map(([center, radiusPoint]) => [center, radiusPoint]);

  const arbitraryMaskType = (): fc.Arbitrary<'brush' | 'rectangle' | 'circle'> =>
    fc.constantFrom('brush', 'rectangle', 'circle');

  const arbitraryOpacity = (): fc.Arbitrary<number> =>
    fc.float({ min: Math.fround(0), max: Math.fround(1) });

  /**
   * Property 3: Mask Creation Tool Correctness
   * **Validates: Requirements 1.1, 1.2, 1.3**
   * 
   * For any valid input coordinates and tool type (brush, rectangle, circle), 
   * the resulting mask should accurately represent the intended selection area
   */
  test('Property 3: Mask Creation Tool Correctness', () => {
    fc.assert(
      fc.property(
        fc.record({
          id: fc.string({ minLength: 1 }).filter(s => s.trim().length > 0),
          type: arbitraryMaskType(),
          canvasSize: arbitraryImageSize(),
          opacity: arbitraryOpacity()
        }).chain(({ id, type, canvasSize, opacity }) => {
          let coordinatesArb: fc.Arbitrary<Point[]>;
          
          switch (type) {
            case 'brush':
              coordinatesArb = arbitraryBrushCoordinates();
              break;
            case 'rectangle':
              coordinatesArb = arbitraryRectangleCoordinates();
              break;
            case 'circle':
              coordinatesArb = arbitraryCircleCoordinates();
              break;
          }
          
          return fc.record({
            id: fc.constant(id),
            type: fc.constant(type),
            coordinates: coordinatesArb,
            canvasSize: fc.constant(canvasSize),
            opacity: fc.constant(opacity)
          });
        }),
        ({ id, type, coordinates, canvasSize, opacity }) => {
          // Create mask using the processor
          const mask = maskProcessor.createMask(id, type, coordinates, canvasSize, opacity);
          
          // Property 1: Mask should have correct basic properties
          expect(mask.id).toBe(id);
          expect(mask.type).toBe(type);
          expect(mask.coordinates).toEqual(coordinates);
          expect(mask.opacity).toBe(opacity);
          
          // Property 2: Mask should have valid bounds
          expect(mask.bounds).toBeDefined();
          expect(mask.bounds.width).toBeGreaterThanOrEqual(0);
          expect(mask.bounds.height).toBeGreaterThanOrEqual(0);
          
          // Property 3: Mask data should be valid ImageData
          expect(mask.data).toBeDefined();
          expect(mask.data.width).toBeGreaterThan(0);
          expect(mask.data.height).toBeGreaterThan(0);
          expect(mask.data.data).toBeDefined();
          expect(mask.data.data.length).toBe(mask.data.width * mask.data.height * 4); // RGBA
          
          // Property 4: Bounds should contain all coordinates for brush type
          if (type === 'brush') {
            coordinates.forEach(coord => {
              expect(coord.x).toBeGreaterThanOrEqual(mask.bounds.x);
              expect(coord.x).toBeLessThanOrEqual(mask.bounds.x + mask.bounds.width);
              expect(coord.y).toBeGreaterThanOrEqual(mask.bounds.y);
              expect(coord.y).toBeLessThanOrEqual(mask.bounds.y + mask.bounds.height);
            });
          }
          
          // Property 5: Rectangle bounds should match coordinate bounds (with minimum size)
          if (type === 'rectangle' && coordinates.length >= 2) {
            const [p1, p2] = coordinates;
            const expectedWidth = Math.max(Math.abs(p2.x - p1.x), 1);
            const expectedHeight = Math.max(Math.abs(p2.y - p1.y), 1);
            expect(mask.bounds.width).toBe(expectedWidth);
            expect(mask.bounds.height).toBe(expectedHeight);
          }
          
          // Property 6: Circle bounds should be square and centered (with minimum radius)
          if (type === 'circle' && coordinates.length >= 2) {
            const [center, radiusPoint] = coordinates;
            const expectedRadius = Math.max(
              Math.sqrt(
                Math.pow(radiusPoint.x - center.x, 2) + Math.pow(radiusPoint.y - center.y, 2)
              ),
              0.5
            );
            const expectedSize = expectedRadius * 2;
            expect(Math.abs(mask.bounds.width - expectedSize)).toBeLessThan(0.001);
            expect(Math.abs(mask.bounds.height - expectedSize)).toBeLessThan(0.001);
          }
          
          // Property 7: Mask should validate successfully
          const validation = maskProcessor.validateMask(mask);
          expect(validation.valid).toBe(true);
          expect(validation.errors).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property: Mask Bounds Calculation Consistency
   * For any set of coordinates, bounds calculation should be deterministic and accurate
   */
  test('Property: Mask Bounds Calculation Consistency', () => {
    fc.assert(
      fc.property(
        fc.record({
          type: arbitraryMaskType(),
          coordinates: fc.array(arbitraryPoint(), { minLength: 2, maxLength: 50 })
        }),
        ({ type, coordinates }) => {
          // Calculate bounds multiple times
          const bounds1 = maskProcessor.calculateBounds(coordinates, type);
          const bounds2 = maskProcessor.calculateBounds(coordinates, type);
          
          // Should be identical
          expect(bounds1).toEqual(bounds2);
          
          // Bounds should be non-negative
          expect(bounds1.width).toBeGreaterThanOrEqual(0);
          expect(bounds1.height).toBeGreaterThanOrEqual(0);
          
          // For brush type, bounds should contain all points
          if (type === 'brush') {
            coordinates.forEach(point => {
              expect(point.x).toBeGreaterThanOrEqual(bounds1.x);
              expect(point.x).toBeLessThanOrEqual(bounds1.x + bounds1.width);
              expect(point.y).toBeGreaterThanOrEqual(bounds1.y);
              expect(point.y).toBeLessThanOrEqual(bounds1.y + bounds1.height);
            });
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property: Mask Validation Correctness
   * For any mask, validation should correctly identify valid and invalid masks
   */
  test('Property: Mask Validation Correctness', () => {
    fc.assert(
      fc.property(
        fc.record({
          id: fc.string({ minLength: 1 }).filter(s => s.trim().length > 0),
          type: arbitraryMaskType(),
          canvasSize: arbitraryImageSize(),
          opacity: arbitraryOpacity()
        }).chain(({ id, type, canvasSize, opacity }) => {
          let coordinatesArb: fc.Arbitrary<Point[]>;
          
          switch (type) {
            case 'brush':
              coordinatesArb = arbitraryBrushCoordinates();
              break;
            case 'rectangle':
              coordinatesArb = arbitraryRectangleCoordinates();
              break;
            case 'circle':
              coordinatesArb = arbitraryCircleCoordinates();
              break;
          }
          
          return fc.record({
            id: fc.constant(id),
            type: fc.constant(type),
            coordinates: coordinatesArb,
            canvasSize: fc.constant(canvasSize),
            opacity: fc.constant(opacity)
          });
        }),
        ({ id, type, coordinates, canvasSize, opacity }) => {
          const mask = maskProcessor.createMask(id, type, coordinates, canvasSize, opacity);
          const validation = maskProcessor.validateMask(mask);
          
          // Valid masks should pass validation
          expect(validation.valid).toBe(true);
          expect(validation.errors).toHaveLength(0);
          
          // Test with invalid mask (empty ID)
          const invalidMask = { ...mask, id: '' };
          const invalidValidation = maskProcessor.validateMask(invalidMask);
          expect(invalidValidation.valid).toBe(false);
          expect(invalidValidation.errors.length).toBeGreaterThan(0);
          
          // Test with invalid opacity
          const invalidOpacityMask = { ...mask, opacity: 2.0 };
          const opacityValidation = maskProcessor.validateMask(invalidOpacityMask);
          expect(opacityValidation.valid).toBe(false);
          expect(opacityValidation.errors.some(e => e.includes('opacity'))).toBe(true);
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Property: Mask Simplification Preserves Essential Shape
   * For any brush mask, simplification should preserve the essential shape while reducing complexity
   */
  test('Property: Mask Simplification Preserves Essential Shape', () => {
    fc.assert(
      fc.property(
        fc.record({
          coordinates: fc.array(arbitraryPoint(), { minLength: 10, maxLength: 100 }),
          tolerance: fc.float({ min: Math.fround(0.1), max: Math.fround(10.0) })
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
          
          // Simplified mask should have same or fewer coordinates
          expect(simplifiedMask.coordinates.length).toBeLessThanOrEqual(originalMask.coordinates.length);
          
          // Should preserve first and last points for brush masks
          if (originalMask.coordinates.length > 0) {
            expect(simplifiedMask.coordinates[0]).toEqual(originalMask.coordinates[0]);
            if (simplifiedMask.coordinates.length > 1) {
              expect(simplifiedMask.coordinates[simplifiedMask.coordinates.length - 1])
                .toEqual(originalMask.coordinates[originalMask.coordinates.length - 1]);
            }
          }
          
          // Should maintain same type and other properties
          expect(simplifiedMask.type).toBe(originalMask.type);
          expect(simplifiedMask.id).toBe(originalMask.id);
          expect(simplifiedMask.opacity).toBe(originalMask.opacity);
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Property: Mask Merging Preserves Coverage
   * For any set of masks, merging should preserve the coverage area
   */
  test('Property: Mask Merging Preserves Coverage', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1 }).filter(s => s.trim().length > 0),
            type: arbitraryMaskType(),
            coordinates: fc.array(arbitraryPoint(), { minLength: 2, maxLength: 10 }),
            opacity: arbitraryOpacity()
          }),
          { minLength: 1, maxLength: 5 }
        ),
        (maskConfigs) => {
          const canvasSize = { width: 1000, height: 1000 };
          const masks = maskConfigs.map((config, index) => 
            maskProcessor.createMask(
              `${config.id}_${index}`,
              config.type,
              config.coordinates,
              canvasSize,
              config.opacity
            )
          );
          
          if (masks.length === 1) {
            const merged = maskProcessor.mergeMasks(masks);
            expect(merged.id).toBeDefined();
            expect(merged.type).toBe(masks[0].type); // Single mask preserves original type
            return;
          }
          
          const mergedMask = maskProcessor.mergeMasks(masks);
          
          // Merged mask should be valid
          const validation = maskProcessor.validateMask(mergedMask);
          expect(validation.valid).toBe(true);
          
          // Merged mask should have brush type
          expect(mergedMask.type).toBe('brush');
          
          // Merged mask bounds should contain all original mask bounds (with floating point tolerance)
          const tolerance = 1e-10;
          masks.forEach(mask => {
            expect(mergedMask.bounds.x).toBeLessThanOrEqual(mask.bounds.x + tolerance);
            expect(mergedMask.bounds.y).toBeLessThanOrEqual(mask.bounds.y + tolerance);
            expect(mergedMask.bounds.x + mergedMask.bounds.width)
              .toBeGreaterThanOrEqual(mask.bounds.x + mask.bounds.width - tolerance);
            expect(mergedMask.bounds.y + mergedMask.bounds.height)
              .toBeGreaterThanOrEqual(mask.bounds.y + mask.bounds.height - tolerance);
          });
        }
      ),
      { numRuns: 30 }
    );
  });
});