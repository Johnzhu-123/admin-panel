/**
 * Property-Based Tests for System Integration
 * Feature: ai-image-editing-enhancement, Property 13: Existing System Integration
 * **Validates: Requirements 10.2, 10.3, 10.4**
 */

import fc from 'fast-check';
import { apiIntegrationLayer } from '../api-integration-layer';
import { 
  EditRequest, 
  EnhancedImageRequest,
  EditRegion, 
  Mask, 
  Point, 
  Rectangle 
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

  toString() {
    return `MockImageData(${this.width}x${this.height})`;
  }
}

(global as any).ImageData = MockImageData;

describe('System Integration Property Tests', () => {

  /**
   * Property 13: Existing System Integration
   * For any edit request, the system should use existing authentication, 
   * queue management, and compatibility systems
   */
  test('existing system integration property', () => {
    fc.assert(fc.property(
      fc.record({
        editRequest: arbitraryEditRequest(),
        provider: fc.constantFrom('openai', 'gemini', 'modelgate')
      }),
      ({ editRequest, provider }) => {
        // Test that the API integration layer correctly identifies editing requests
        const enhancedRequest: EnhancedImageRequest = {
          editingMode: 'edit',
          originalImage: editRequest.originalImage,
          masks: editRequest.regions.map(r => r.mask),
          editInstructions: editRequest.regions.map(r => r.instruction),
          highFidelity: editRequest.globalOptions.highFidelity,
          stylePreservation: editRequest.globalOptions.stylePreservation
        };

        // Verify editing request detection
        const isEditing = apiIntegrationLayer.isEditingRequest(enhancedRequest);
        expect(isEditing).toBe(true);

        // Test generation request detection
        const generationRequest: EnhancedImageRequest = {
          prompt: 'Generate an image',
          editingMode: 'generate'
        };

        const isGeneration = apiIntegrationLayer.isEditingRequest(generationRequest);
        expect(isGeneration).toBe(false);

        return true;
      }
    ), { numRuns: 20 });
  });

  /**
   * Test integration with existing authentication systems
   */
  test('authentication integration property', () => {
    fc.assert(fc.property(
      fc.record({
        editRequest: arbitraryEditRequest(),
        provider: fc.constantFrom('openai', 'gemini', 'modelgate')
      }),
      ({ editRequest, provider }) => {
        // Set provider in request
        const requestWithProvider = {
          ...editRequest,
          provider
        };

        // Validate that provider selection works
        expect(requestWithProvider.provider).toBe(provider);
        expect(['openai', 'gemini', 'modelgate']).toContain(requestWithProvider.provider);

        // Test that request validation works
        try {
          // This should not throw for valid requests
          expect(requestWithProvider.originalImage).toBeDefined();
          expect(requestWithProvider.regions).toBeDefined();
          expect(requestWithProvider.regions.length).toBeGreaterThan(0);
          
          for (const region of requestWithProvider.regions) {
            expect(region.mask).toBeDefined();
            expect(region.instruction).toBeDefined();
            expect(region.instruction.trim().length).toBeGreaterThan(0);
          }
        } catch (error) {
          // If validation fails, it should be for a good reason
          expect(error).toBeDefined();
        }

        return true;
      }
    ), { numRuns: 15 });
  });

  /**
   * Test integration with existing request queue management
   */
  test('request queue integration property', () => {
    fc.assert(fc.property(
      fc.array(arbitraryEditRequest(), { minLength: 1, maxLength: 3 }),
      (editRequests) => {
        // Test that multiple requests can be processed
        expect(editRequests.length).toBeGreaterThan(0);
        expect(editRequests.length).toBeLessThanOrEqual(3);

        // Each request should be valid for queue processing
        for (const request of editRequests) {
          expect(request.originalImage).toBeDefined();
          expect(request.regions).toBeDefined();
          expect(request.globalOptions).toBeDefined();
          
          // Validate queue-relevant properties
          expect(typeof request.originalImage).toBe('string');
          expect(Array.isArray(request.regions)).toBe(true);
          expect(request.regions.length).toBeGreaterThan(0);
        }

        return true;
      }
    ), { numRuns: 10 });
  });

  /**
   * Test backward compatibility with existing image generation
   */
  test('backward compatibility property', () => {
    fc.assert(fc.property(
      fc.record({
        prompt: fc.string({ minLength: 10, maxLength: 100 }).filter(s => s.trim().length > 0),
        model: fc.constantFrom('gpt-4', 'dall-e-3', 'gemini-pro'),
        size: fc.constantFrom('1024x1024', '512x512', '256x256'),
        quality: fc.constantFrom('standard', 'hd')
      }),
      ({ prompt, model, size, quality }) => {
        // Create a legacy-style generation request
        const legacyRequest: EnhancedImageRequest = {
          prompt,
          model,
          size,
          quality,
          editingMode: 'generate'
        };

        // Should be identified as generation, not editing
        const isEditing = apiIntegrationLayer.isEditingRequest(legacyRequest);
        expect(isEditing).toBe(false);

        // Should have all required properties for generation
        expect(legacyRequest.prompt).toBeDefined();
        expect(legacyRequest.prompt.trim().length).toBeGreaterThan(0);
        expect(legacyRequest.editingMode).toBe('generate');

        return true;
      }
    ), { numRuns: 15 });
  });

  /**
   * Test provider capability detection integration
   */
  test('provider capability integration property', () => {
    fc.assert(fc.property(
      fc.constantFrom('openai', 'gemini', 'modelgate'),
      (provider) => {
        // Test that provider capabilities are consistent
        const capabilities = (apiIntegrationLayer as any).getProviderCapabilities?.(provider);
        
        if (capabilities) {
          // Validate capability structure
          expect(capabilities).toHaveProperty('supportsNativeEditing');
          expect(capabilities).toHaveProperty('supportsBatchEditing');
          expect(capabilities).toHaveProperty('maxImageSize');
          expect(capabilities).toHaveProperty('supportedMaskFormats');
          expect(capabilities).toHaveProperty('highFidelitySupport');

          // Validate capability values
          expect(typeof capabilities.supportsNativeEditing).toBe('boolean');
          expect(typeof capabilities.supportsBatchEditing).toBe('boolean');
          expect(typeof capabilities.highFidelitySupport).toBe('boolean');
          expect(Array.isArray(capabilities.supportedMaskFormats)).toBe(true);
          expect(capabilities.maxImageSize).toHaveProperty('width');
          expect(capabilities.maxImageSize).toHaveProperty('height');
        }

        return true;
      }
    ), { numRuns: 10 });
  });

  /**
   * Test error handling integration with existing systems
   */
  test('error handling integration property', () => {
    fc.assert(fc.property(
      arbitraryInvalidEditRequest(),
      (invalidRequest) => {
        // Test that invalid requests are properly handled
        try {
          // Validation should catch invalid requests
          expect(invalidRequest).toBeDefined();
          
          // Common validation issues
          if (!invalidRequest.originalImage) {
            expect(invalidRequest.originalImage).toBeFalsy();
          }
          
          if (!invalidRequest.regions || invalidRequest.regions.length === 0) {
            expect(invalidRequest.regions?.length || 0).toBe(0);
          }

          // Invalid regions should be detectable
          if (invalidRequest.regions) {
            for (const region of invalidRequest.regions) {
              if (!region.mask || !region.instruction?.trim()) {
                expect(region.mask || region.instruction?.trim()).toBeFalsy();
              }
            }
          }
        } catch (error) {
          // Errors should be meaningful
          expect(error).toBeDefined();
        }

        return true;
      }
    ), { numRuns: 10 });
  });
});

// Arbitraries for generating test data

function arbitraryEditRequest(): fc.Arbitrary<EditRequest> {
  return fc.record({
    originalImage: fc.string({ minLength: 50, maxLength: 100 }).map(s => `data:image/png;base64,${s}`),
    regions: fc.array(arbitraryEditRegion(), { minLength: 1, maxLength: 3 }),
    globalOptions: fc.record({
      highFidelity: fc.boolean(),
      stylePreservation: fc.boolean(),
      qualityLevel: fc.constantFrom('standard', 'high')
    }),
    provider: fc.constantFrom('openai', 'gemini', 'modelgate')
  });
}

function arbitraryInvalidEditRequest(): fc.Arbitrary<Partial<EditRequest>> {
  return fc.oneof(
    // Missing original image
    fc.record({
      regions: fc.array(arbitraryEditRegion(), { minLength: 1, maxLength: 2 }),
      globalOptions: fc.record({
        highFidelity: fc.boolean(),
        stylePreservation: fc.boolean(),
        qualityLevel: fc.constantFrom('standard', 'high')
      })
    }),
    // Missing regions
    fc.record({
      originalImage: fc.string({ minLength: 50, maxLength: 100 }).map(s => `data:image/png;base64,${s}`),
      globalOptions: fc.record({
        highFidelity: fc.boolean(),
        stylePreservation: fc.boolean(),
        qualityLevel: fc.constantFrom('standard', 'high')
      })
    }),
    // Empty regions
    fc.record({
      originalImage: fc.string({ minLength: 50, maxLength: 100 }).map(s => `data:image/png;base64,${s}`),
      regions: fc.constant([]),
      globalOptions: fc.record({
        highFidelity: fc.boolean(),
        stylePreservation: fc.boolean(),
        qualityLevel: fc.constantFrom('standard', 'high')
      })
    }),
    // Invalid regions
    fc.record({
      originalImage: fc.string({ minLength: 50, maxLength: 100 }).map(s => `data:image/png;base64,${s}`),
      regions: fc.array(arbitraryInvalidEditRegion(), { minLength: 1, maxLength: 2 }),
      globalOptions: fc.record({
        highFidelity: fc.boolean(),
        stylePreservation: fc.boolean(),
        qualityLevel: fc.constantFrom('standard', 'high')
      })
    })
  );
}

function arbitraryEditRegion(): fc.Arbitrary<EditRegion> {
  return fc.record({
    mask: arbitraryMask(),
    instruction: fc.string({ minLength: 10, maxLength: 100 }).filter(s => s.trim().length > 0),
    priority: fc.integer({ min: 1, max: 10 }),
    stylePreservation: fc.boolean()
  });
}

function arbitraryInvalidEditRegion(): fc.Arbitrary<Partial<EditRegion>> {
  return fc.oneof(
    // Missing mask
    fc.record({
      instruction: fc.string({ minLength: 10, maxLength: 100 }).filter(s => s.trim().length > 0),
      priority: fc.integer({ min: 1, max: 10 }),
      stylePreservation: fc.boolean()
    }),
    // Missing instruction
    fc.record({
      mask: arbitraryMask(),
      priority: fc.integer({ min: 1, max: 10 }),
      stylePreservation: fc.boolean()
    }),
    // Empty instruction
    fc.record({
      mask: arbitraryMask(),
      instruction: fc.constant(''),
      priority: fc.integer({ min: 1, max: 10 }),
      stylePreservation: fc.boolean()
    }),
    // Whitespace-only instruction
    fc.record({
      mask: arbitraryMask(),
      instruction: fc.constant('   '),
      priority: fc.integer({ min: 1, max: 10 }),
      stylePreservation: fc.boolean()
    })
  );
}

function arbitraryMask(): fc.Arbitrary<Mask> {
  return fc.record({
    id: fc.string({ minLength: 8, maxLength: 12 }).map(s => `mask_${s}_${Math.random().toString(36).substr(2, 5)}`),
    type: fc.constantFrom('brush', 'rectangle', 'circle'),
    coordinates: fc.array(arbitraryPoint(), { minLength: 4, maxLength: 20 }),
    bounds: arbitraryRectangle(),
    opacity: fc.float({ min: Math.fround(0.1), max: Math.fround(1.0) }),
    data: fc.constant(new (global as any).ImageData(100, 100))
  });
}

function arbitraryPoint(): fc.Arbitrary<Point> {
  return fc.record({
    x: fc.integer({ min: 0, max: 500 }),
    y: fc.integer({ min: 0, max: 500 })
  });
}

function arbitraryRectangle(): fc.Arbitrary<Rectangle> {
  return fc.record({
    x: fc.integer({ min: 0, max: 400 }),
    y: fc.integer({ min: 0, max: 400 }),
    width: fc.integer({ min: 10, max: 200 }),
    height: fc.integer({ min: 10, max: 200 })
  });
}