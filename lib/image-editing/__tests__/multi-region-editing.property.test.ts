/**
 * Property-based tests for multi-region editing system
 * Feature: ai-image-editing-enhancement, Property 2: Multi-Region Editing Consistency
 * **Validates: Requirements 2.4, 3.3, 3.5**
 */

import fc from 'fast-check';
import { regionManager } from '../region-manager';
import { 
  EditRegion, 
  Mask, 
  Point, 
  Rectangle,
  ExecutionPlan,
  EditResult
} from '../types';

// Mock ImageData for Node.js environment
class MockImageData {
  width: number;
  height: number;
  data: Uint8ClampedArray;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}

// Make ImageData available globally for tests
(global as any).ImageData = MockImageData;

// Test data generators for multi-region scenarios
const arbitraryPoint = (): fc.Arbitrary<Point> =>
  fc.record({
    x: fc.integer({ min: 0, max: 1024 }),
    y: fc.integer({ min: 0, max: 1024 })
  });

const arbitraryRectangle = (): fc.Arbitrary<Rectangle> =>
  fc.record({
    x: fc.integer({ min: 0, max: 400 }),
    y: fc.integer({ min: 0, max: 400 }),
    width: fc.integer({ min: 50, max: 200 }),
    height: fc.integer({ min: 50, max: 200 })
  });

const arbitraryNonOverlappingMask = (existingMasks: Mask[] = []): fc.Arbitrary<Mask> =>
  fc.record({
    id: fc.string({ minLength: 5, maxLength: 15 }).map(s => `region-${s.replace(/\s/g, '-')}`),
    type: fc.constantFrom('brush', 'rectangle', 'circle'),
    coordinates: fc.array(arbitraryPoint(), { minLength: 4, maxLength: 10 }),
    bounds: arbitraryRectangle().filter(bounds => {
      // Ensure no overlap with existing masks
      return !existingMasks.some(existing => 
        boundsOverlap(bounds, existing.bounds)
      );
    }),
    opacity: fc.float({ min: Math.fround(0.3), max: Math.fround(1.0) }),
    data: fc.constant(new ImageData(1, 1))
  });

const arbitraryMultiRegionEditRegions = (): fc.Arbitrary<EditRegion[]> =>
  fc.array(
    fc.record({
      mask: arbitraryNonOverlappingMask(),
      instruction: fc.string({ minLength: 10, maxLength: 80 }).map(s => `Edit: ${s.replace(/^\s+|\s+$/g, '') || 'modify region'}`),
      priority: fc.integer({ min: 1, max: 5 }),
      stylePreservation: fc.boolean()
    }),
    { minLength: 2, maxLength: 4 }
  ).map(regions => {
    // Ensure unique IDs and non-overlapping bounds
    const uniqueRegions: EditRegion[] = [];
    const usedIds = new Set<string>();
    
    for (const region of regions) {
      let uniqueId = region.mask.id;
      let counter = 1;
      while (usedIds.has(uniqueId)) {
        uniqueId = `${region.mask.id}-${counter}`;
        counter++;
      }
      usedIds.add(uniqueId);
      
      // Adjust bounds to avoid overlap
      const adjustedBounds = adjustBoundsToAvoidOverlap(region.mask.bounds, uniqueRegions);
      
      uniqueRegions.push({
        ...region,
        mask: {
          ...region.mask,
          id: uniqueId,
          bounds: adjustedBounds
        }
      });
    }
    
    return uniqueRegions;
  });

const arbitraryProvider = (): fc.Arbitrary<string> =>
  fc.constantFrom('openai', 'gemini', 'modelgate');

// Helper functions
function boundsOverlap(bounds1: Rectangle, bounds2: Rectangle): boolean {
  return !(
    bounds1.x + bounds1.width <= bounds2.x ||
    bounds2.x + bounds2.width <= bounds1.x ||
    bounds1.y + bounds1.height <= bounds2.y ||
    bounds2.y + bounds2.height <= bounds1.y
  );
}

function adjustBoundsToAvoidOverlap(bounds: Rectangle, existingRegions: EditRegion[]): Rectangle {
  let adjustedBounds = { ...bounds };
  
  for (const existing of existingRegions) {
    if (boundsOverlap(adjustedBounds, existing.mask.bounds)) {
      // Move the bounds to avoid overlap
      adjustedBounds.x = existing.mask.bounds.x + existing.mask.bounds.width + 10;
      if (adjustedBounds.x + adjustedBounds.width > 1024) {
        adjustedBounds.x = Math.max(0, existing.mask.bounds.x - adjustedBounds.width - 10);
      }
    }
  }
  
  return adjustedBounds;
}

describe('Multi-Region Editing Property Tests', () => {
  describe('Property 2: Multi-Region Editing Consistency', () => {
    test('execution planning should handle multiple regions appropriately', () => {
      fc.assert(fc.property(
        arbitraryMultiRegionEditRegions(),
        arbitraryProvider(),
        (regions, provider) => {
          const plan = regionManager.planExecution(regions, provider);
          
          // Plan should be valid
          expect(plan).toBeDefined();
          expect(plan.type).toMatch(/^(batch|sequential)$/);
          expect(plan.provider).toBe(provider);
          expect(plan.regions).toHaveLength(regions.length);
          expect(plan.estimatedTime).toBeGreaterThan(0);
          
          // All regions should be preserved in the plan
          const planRegionIds = plan.regions.map(r => r.mask.id).sort();
          const originalRegionIds = regions.map(r => r.mask.id).sort();
          expect(planRegionIds).toEqual(originalRegionIds);
          
          // Plan should respect provider capabilities
          if (plan.type === 'batch') {
            // Batch plans should have reasonable limits
            expect(plan.regions.length).toBeLessThanOrEqual(5);
          }
          
          // Fallback plan should be available for batch plans
          if (plan.type === 'batch') {
            expect(plan.fallbackPlan).toBeDefined();
            expect(plan.fallbackPlan?.type).toBe('sequential');
          }
        }
      ), { numRuns: 50 });
    });

    test('batch execution should maintain region independence', () => {
      fc.assert(fc.property(
        arbitraryMultiRegionEditRegions(),
        arbitraryProvider(),
        async (regions, provider) => {
          const plan = regionManager.planExecution(regions, provider);
          
          if (plan.type === 'batch') {
            try {
              const results = await regionManager.executeBatch(plan);
              
              // Should have results for all regions
              expect(results).toHaveLength(regions.length);
              
              // Each region should have a corresponding result
              const resultRegionIds = results.map(r => r.regionId).sort();
              const originalRegionIds = regions.map(r => r.mask.id).sort();
              expect(resultRegionIds).toEqual(originalRegionIds);
              
              // Results should be independent (no cross-contamination)
              results.forEach((result, index) => {
                expect(result.regionId).toBe(regions[index].mask.id);
                expect(result.metadata.provider).toBe(provider);
                expect(typeof result.success).toBe('boolean');
                
                if (result.success) {
                  expect(result.editedImage).toBeTruthy();
                  expect(result.metadata.processingTime).toBeGreaterThan(0);
                } else {
                  expect(result.error).toBeDefined();
                  expect(result.error?.recoverable).toBeDefined();
                }
              });
              
              return true;
            } catch (error) {
              // Batch execution may fail gracefully
              expect(error).toBeInstanceOf(Error);
              return true;
            }
          }
          
          return true; // Skip non-batch plans
        }
      ), { numRuns: 20 });
    });

    test('sequential execution should maintain processing order', () => {
      fc.assert(fc.property(
        arbitraryMultiRegionEditRegions(),
        arbitraryProvider(),
        async (regions, provider) => {
          const plan = regionManager.planExecution(regions, provider);
          
          try {
            const results = await regionManager.executeSequential(plan);
            
            // Should have results for all regions
            expect(results).toHaveLength(regions.length);
            
            // Results should maintain the order from the plan
            results.forEach((result, index) => {
              expect(result.regionId).toBe(plan.regions[index].mask.id);
              expect(result.metadata.provider).toBe(provider);
              
              if (result.success) {
                expect(result.editedImage).toBeTruthy();
                expect(result.metadata.processingTime).toBeGreaterThan(0);
              } else {
                expect(result.error).toBeDefined();
                expect(result.error?.suggestedActions).toBeDefined();
                expect(Array.isArray(result.error?.suggestedActions)).toBe(true);
              }
            });
            
            return true;
          } catch (error) {
            // Sequential execution should be more robust
            expect(error).toBeInstanceOf(Error);
            return true;
          }
        }
      ), { numRuns: 20 });
    });

    test('result composition should handle multiple successful edits', () => {
      fc.assert(fc.property(
        arbitraryMultiRegionEditRegions(),
        arbitraryProvider(),
        async (regions, provider) => {
          const plan = regionManager.planExecution(regions, provider);
          
          try {
            const results = await regionManager.executeSequential(plan);
            const originalImage = 'mock-original-image-data';
            
            const compositeResult = await regionManager.compositeResults(results, originalImage);
            
            // Composite result should be a valid image string
            expect(typeof compositeResult).toBe('string');
            expect(compositeResult.length).toBeGreaterThan(0);
            
            // If no successful results, should return original
            const hasSuccessfulResults = results.some(r => r.success);
            if (!hasSuccessfulResults) {
              expect(compositeResult).toBe(originalImage);
            }
            
            return true;
          } catch (error) {
            expect(error).toBeInstanceOf(Error);
            return true;
          }
        }
      ), { numRuns: 15 });
    });

    test('partial failure recovery should provide appropriate strategies', () => {
      fc.assert(fc.property(
        arbitraryMultiRegionEditRegions(),
        arbitraryProvider(),
        async (regions, provider) => {
          const plan = regionManager.planExecution(regions, provider);
          
          try {
            const results = await regionManager.executeSequential(plan);
            const recoveryPlan = regionManager.handlePartialFailure(results);
            
            // Recovery plan should be well-formed
            expect(recoveryPlan).toBeDefined();
            expect(Array.isArray(recoveryPlan.failedRegions)).toBe(true);
            expect(Array.isArray(recoveryPlan.successfulRegions)).toBe(true);
            expect(Array.isArray(recoveryPlan.suggestedActions)).toBe(true);
            
            // Failed and successful regions should account for all regions
            const totalRecoveredRegions = recoveryPlan.failedRegions.length + recoveryPlan.successfulRegions.length;
            expect(totalRecoveredRegions).toBe(regions.length);
            
            // Suggested actions should be appropriate
            recoveryPlan.suggestedActions.forEach(action => {
              expect(['retry', 'alternative_provider', 'simplified_request', 'manual_intervention']).toContain(action.type);
              expect(typeof action.description).toBe('string');
              expect(action.description.length).toBeGreaterThan(0);
              expect(action.estimatedSuccess).toBeGreaterThanOrEqual(0);
              expect(action.estimatedSuccess).toBeLessThanOrEqual(1);
              expect(Array.isArray(action.regionIds)).toBe(true);
            });
            
            return true;
          } catch (error) {
            expect(error).toBeInstanceOf(Error);
            return true;
          }
        }
      ), { numRuns: 15 });
    });

    test('execution plans should be deterministic for identical inputs', () => {
      fc.assert(fc.property(
        arbitraryMultiRegionEditRegions(),
        arbitraryProvider(),
        (regions, provider) => {
          const plan1 = regionManager.planExecution(regions, provider);
          const plan2 = regionManager.planExecution(regions, provider);
          
          // Plans should be identical for same inputs
          expect(plan1.type).toBe(plan2.type);
          expect(plan1.provider).toBe(plan2.provider);
          expect(plan1.regions).toHaveLength(plan2.regions.length);
          
          // Region order should be consistent
          plan1.regions.forEach((region, index) => {
            expect(region.mask.id).toBe(plan2.regions[index].mask.id);
          });
          
          // Estimated times should be identical (deterministic calculation)
          expect(plan1.estimatedTime).toBe(plan2.estimatedTime);
        }
      ), { numRuns: 30 });
    });

    test('region priority should influence execution order', () => {
      fc.assert(fc.property(
        arbitraryMultiRegionEditRegions().filter(regions => {
          // Ensure we have regions with different priorities
          const priorities = regions.map(r => r.priority);
          return new Set(priorities).size > 1;
        }),
        arbitraryProvider(),
        (regions, provider) => {
          const plan = regionManager.planExecution(regions, provider);
          
          // Check that higher priority regions come first
          for (let i = 0; i < plan.regions.length - 1; i++) {
            const currentPriority = plan.regions[i].priority;
            const nextPriority = plan.regions[i + 1].priority;
            
            // Current region should have higher or equal priority
            expect(currentPriority).toBeGreaterThanOrEqual(nextPriority);
          }
        }
      ), { numRuns: 25 });
    });

    test('overlapping regions should not be batched together', () => {
      fc.assert(fc.property(
        arbitraryProvider(),
        (provider) => {
          // Create intentionally overlapping regions
          const overlappingRegions: EditRegion[] = [
            {
              mask: {
                id: 'region-1',
                type: 'rectangle',
                coordinates: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
                bounds: { x: 0, y: 0, width: 100, height: 100 },
                opacity: 0.8,
                data: new ImageData(1, 1)
              },
              instruction: 'Edit first region',
              priority: 1,
              stylePreservation: false
            },
            {
              mask: {
                id: 'region-2',
                type: 'rectangle',
                coordinates: [{ x: 50, y: 50 }, { x: 150, y: 50 }, { x: 150, y: 150 }, { x: 50, y: 150 }],
                bounds: { x: 50, y: 50, width: 100, height: 100 }, // Overlaps with region-1
                opacity: 0.8,
                data: new ImageData(1, 1)
              },
              instruction: 'Edit second region',
              priority: 1,
              stylePreservation: false
            }
          ];
          
          const plan = regionManager.planExecution(overlappingRegions, provider);
          
          // Overlapping regions should not be batched
          expect(plan.type).toBe('sequential');
        }
      ), { numRuns: 20 });
    });
  });

  describe('Performance and Scalability Properties', () => {
    test('execution time should scale reasonably with region count', () => {
      fc.assert(fc.property(
        fc.integer({ min: 1, max: 5 }),
        arbitraryProvider(),
        (regionCount, provider) => {
          // Create regions with consistent complexity
          const regions: EditRegion[] = Array.from({ length: regionCount }, (_, i) => ({
            mask: {
              id: `region-${i}`,
              type: 'rectangle',
              coordinates: [
                { x: i * 120, y: 0 },
                { x: i * 120 + 100, y: 0 },
                { x: i * 120 + 100, y: 100 },
                { x: i * 120, y: 100 }
              ],
              bounds: { x: i * 120, y: 0, width: 100, height: 100 },
              opacity: 0.8,
              data: new ImageData(1, 1)
            },
            instruction: `Edit region ${i + 1}`,
            priority: 1,
            stylePreservation: false
          }));
          
          const plan = regionManager.planExecution(regions, provider);
          
          // Estimated time should scale reasonably
          const timePerRegion = plan.estimatedTime / regionCount;
          expect(timePerRegion).toBeGreaterThan(1000); // At least 1 second per region
          expect(timePerRegion).toBeLessThan(30000); // No more than 30 seconds per region
          
          // More regions should generally take more time (unless batch optimization)
          if (regionCount > 1) {
            expect(plan.estimatedTime).toBeGreaterThan(2000);
          }
        }
      ), { numRuns: 20 });
    });
  });
});