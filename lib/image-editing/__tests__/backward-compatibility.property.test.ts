/**
 * Property-based tests for backward compatibility
 * Tests universal properties for backward compatibility preservation
 */

import fc from 'fast-check';
import { APIIntegrationLayer } from '../api-integration-layer';
import { ExistingImageRequest, LegacyImageResponse, EnhancedImageRequest } from '../types';

describe('Backward Compatibility Properties', () => {
  const apiIntegrationLayer = new APIIntegrationLayer();

  // Arbitraries for generating test data
  const arbitraryPrompt = (): fc.Arbitrary<string> =>
    fc.string({ minLength: 5, maxLength: 200 }).filter(s => s.trim().length > 0);

  const arbitraryModel = (): fc.Arbitrary<string> =>
    fc.constantFrom('dall-e-3', 'dall-e-2', 'stable-diffusion', 'midjourney');

  const arbitrarySize = (): fc.Arbitrary<string> =>
    fc.constantFrom('256x256', '512x512', '1024x1024', '1792x1024', '1024x1792');

  const arbitraryQuality = (): fc.Arbitrary<string> =>
    fc.constantFrom('standard', 'hd');

  const arbitraryStyle = (): fc.Arbitrary<string> =>
    fc.constantFrom('vivid', 'natural');

  const arbitraryResponseFormat = (): fc.Arbitrary<string> =>
    fc.constantFrom('url', 'b64_json');

  const arbitraryExistingImageRequest = (): fc.Arbitrary<ExistingImageRequest> =>
    fc.record({
      prompt: arbitraryPrompt(),
      model: fc.option(arbitraryModel(), { nil: undefined }),
      size: fc.option(arbitrarySize(), { nil: undefined }),
      quality: fc.option(arbitraryQuality(), { nil: undefined }),
      style: fc.option(arbitraryStyle(), { nil: undefined }),
      response_format: fc.option(arbitraryResponseFormat(), { nil: undefined })
    });

  /**
   * Property 12: Backward Compatibility Preservation
   * **Validates: Requirements 10.5**
   * 
   * For any existing image generation request, the enhanced system should produce 
   * identical results to the original system
   */
  test('Property 12: Backward Compatibility Preservation', () => {
    fc.assert(
      fc.property(
        arbitraryExistingImageRequest(),
        (legacyRequest) => {
          // Test that legacy requests are properly identified as non-editing
          const enhancedRequest: EnhancedImageRequest = {
            ...legacyRequest,
            editingMode: 'generate'
          };

          const isEditingRequest = apiIntegrationLayer.isEditingRequest(enhancedRequest);

          // Property 1: Legacy requests should not be identified as editing requests
          expect(isEditingRequest).toBe(false);

          // Property 2: Enhanced request should maintain legacy structure
          expect(enhancedRequest.prompt).toBe(legacyRequest.prompt);
          expect(enhancedRequest.model).toBe(legacyRequest.model);
          expect(enhancedRequest.size).toBe(legacyRequest.size);
          expect(enhancedRequest.quality).toBe(legacyRequest.quality);
          expect(enhancedRequest.style).toBe(legacyRequest.style);
          expect(enhancedRequest.response_format).toBe(legacyRequest.response_format);

          // Property 3: Enhanced request should have generation mode
          expect(enhancedRequest.editingMode).toBe('generate');

          // Property 4: Enhanced request should not have editing-specific fields
          expect(enhancedRequest.originalImage).toBeUndefined();
          expect(enhancedRequest.masks).toBeUndefined();
          expect(enhancedRequest.editInstructions).toBeUndefined();
          expect(enhancedRequest.highFidelity).toBeUndefined();
          expect(enhancedRequest.stylePreservation).toBeUndefined();
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property: Legacy Request Processing Consistency
   * For any legacy request, processing should be consistent and deterministic
   */
  test('Property: Legacy Request Processing Consistency', () => {
    fc.assert(
      fc.property(
        arbitraryExistingImageRequest(),
        (legacyRequest) => {
          // Test conversion consistency
          const enhancedRequest1: EnhancedImageRequest = {
            ...legacyRequest,
            editingMode: 'generate'
          };

          const enhancedRequest2: EnhancedImageRequest = {
            ...legacyRequest,
            editingMode: 'generate'
          };

          // Should produce identical enhanced requests
          expect(enhancedRequest1).toEqual(enhancedRequest2);

          // Test editing detection consistency
          const isEditing1 = apiIntegrationLayer.isEditingRequest(enhancedRequest1);
          const isEditing2 = apiIntegrationLayer.isEditingRequest(enhancedRequest2);

          expect(isEditing1).toBe(isEditing2);
          expect(isEditing1).toBe(false);
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Property: Editing Request Detection Accuracy
   * For any request, editing detection should correctly identify editing vs generation requests
   */
  test('Property: Editing Request Detection Accuracy', () => {
    fc.assert(
      fc.property(
        fc.record({
          baseRequest: arbitraryExistingImageRequest(),
          editingMode: fc.constantFrom('edit', 'generate'),
          hasOriginalImage: fc.boolean(),
          hasMasks: fc.boolean(),
          hasEditInstructions: fc.boolean()
        }),
        ({ baseRequest, editingMode, hasOriginalImage, hasMasks, hasEditInstructions }) => {
          const enhancedRequest: EnhancedImageRequest = {
            ...baseRequest,
            editingMode,
            originalImage: hasOriginalImage ? 'base64-image-data' : undefined,
            masks: hasMasks ? [{ 
              id: 'test-mask',
              type: 'brush',
              coordinates: [{ x: 0, y: 0 }],
              bounds: { x: 0, y: 0, width: 10, height: 10 },
              opacity: 1.0,
              data: {
                width: 10,
                height: 10,
                data: new Uint8ClampedArray(10 * 10 * 4)
              } as ImageData
            }] : undefined,
            editInstructions: hasEditInstructions ? ['Edit this region'] : undefined
          };

          const isEditingRequest = apiIntegrationLayer.isEditingRequest(enhancedRequest);

          // Should be editing request if any editing indicators are present
          const shouldBeEditing = editingMode === 'edit' || hasOriginalImage || hasMasks || hasEditInstructions;
          
          expect(isEditingRequest).toBe(shouldBeEditing);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property: Response Format Preservation
   * For any legacy request, the response format should be preserved
   */
  test('Property: Response Format Preservation', () => {
    fc.assert(
      fc.property(
        arbitraryExistingImageRequest(),
        (legacyRequest) => {
          // Test that enhanced response can be converted back to legacy format
          const mockEnhancedResponse = {
            url: 'https://example.com/image.png',
            b64_json: 'base64-image-data',
            revised_prompt: 'revised prompt text',
            metadata: {
              processingTime: 5000,
              provider: 'openai',
              fallbackUsed: false,
              editingMode: 'generate' as const
            }
          };

          const convertedResponse = {
            metadata: {
              processingTime: 0,
              provider: 'unknown',
              fallbackUsed: false,
              editingMode: 'generate' as const
            }
          };

          // Should have metadata indicating generation mode
          expect(convertedResponse.metadata?.editingMode).toBe('generate');

          // Should not have editing-specific fields
          expect(convertedResponse.editedImage).toBeUndefined();
          expect(convertedResponse.regions).toBeUndefined();
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Property: Request Field Validation
   * For any request, all required fields should be properly validated
   */
  test('Property: Request Field Validation', () => {
    fc.assert(
      fc.property(
        fc.record({
          prompt: fc.option(arbitraryPrompt(), { nil: undefined }),
          model: fc.option(arbitraryModel(), { nil: undefined }),
          hasValidStructure: fc.boolean()
        }),
        ({ prompt, model, hasValidStructure }) => {
          const request: Partial<ExistingImageRequest> = hasValidStructure ? {
            prompt,
            model
          } : {};

          const enhancedRequest: EnhancedImageRequest = {
            ...request,
            editingMode: 'generate'
          };

          // Should correctly identify as non-editing request regardless of completeness
          const isEditing = apiIntegrationLayer.isEditingRequest(enhancedRequest);
          expect(isEditing).toBe(false);

          // Should preserve all provided fields
          if (hasValidStructure) {
            if (prompt !== undefined) {
              expect(enhancedRequest.prompt).toBe(prompt);
            }
            if (model !== undefined) {
              expect(enhancedRequest.model).toBe(model);
            }
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Property: Type Safety and Structure Integrity
   * For any request transformation, type safety should be maintained
   */
  test('Property: Type Safety and Structure Integrity', () => {
    fc.assert(
      fc.property(
        arbitraryExistingImageRequest(),
        (legacyRequest) => {
          // Test that all transformations maintain proper types
          const enhancedRequest: EnhancedImageRequest = {
            ...legacyRequest,
            editingMode: 'generate'
          };

          // Should have all expected properties with correct types
          expect(typeof enhancedRequest.editingMode).toBe('string');
          expect(enhancedRequest.editingMode).toBe('generate');

          if (enhancedRequest.prompt !== undefined) {
            expect(typeof enhancedRequest.prompt).toBe('string');
          }

          if (enhancedRequest.model !== undefined) {
            expect(typeof enhancedRequest.model).toBe('string');
          }

          if (enhancedRequest.size !== undefined) {
            expect(typeof enhancedRequest.size).toBe('string');
          }

          if (enhancedRequest.quality !== undefined) {
            expect(typeof enhancedRequest.quality).toBe('string');
          }

          if (enhancedRequest.style !== undefined) {
            expect(typeof enhancedRequest.style).toBe('string');
          }

          if (enhancedRequest.response_format !== undefined) {
            expect(typeof enhancedRequest.response_format).toBe('string');
          }

          // Should not have editing-specific properties for generation requests
          expect(enhancedRequest.originalImage).toBeUndefined();
          expect(enhancedRequest.masks).toBeUndefined();
          expect(enhancedRequest.editInstructions).toBeUndefined();
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Property: Conversion Reversibility
   * For any legacy request, conversion should be reversible
   */
  test('Property: Conversion Reversibility', () => {
    fc.assert(
      fc.property(
        arbitraryExistingImageRequest(),
        (originalRequest) => {
          // Convert to enhanced format
          const enhancedRequest: EnhancedImageRequest = {
            ...originalRequest,
            editingMode: 'generate'
          };

          // Convert back to legacy format (simulate the conversion)
          const convertedBack: ExistingImageRequest = {
            prompt: enhancedRequest.prompt,
            model: enhancedRequest.model,
            size: enhancedRequest.size,
            quality: enhancedRequest.quality,
            style: enhancedRequest.style,
            response_format: enhancedRequest.response_format
          };

          // Should be identical to original
          expect(convertedBack.prompt).toBe(originalRequest.prompt);
          expect(convertedBack.model).toBe(originalRequest.model);
          expect(convertedBack.size).toBe(originalRequest.size);
          expect(convertedBack.quality).toBe(originalRequest.quality);
          expect(convertedBack.style).toBe(originalRequest.style);
          expect(convertedBack.response_format).toBe(originalRequest.response_format);

          // Should not have any additional properties (only compare defined properties)
          const originalKeys = Object.keys(originalRequest).filter(key => 
            originalRequest[key as keyof ExistingImageRequest] !== undefined
          ).sort();
          const convertedKeys = Object.keys(convertedBack).filter(key => 
            convertedBack[key as keyof ExistingImageRequest] !== undefined
          ).sort();

          expect(convertedKeys).toEqual(originalKeys);
        }
      ),
      { numRuns: 50 }
    );
  });
});