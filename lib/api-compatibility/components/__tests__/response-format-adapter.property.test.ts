// Property-based tests for Response Format Adapter

import * as fc from 'fast-check';
import { ResponseFormatAdapter } from '../response-format-adapter';
import { APIProvider, ImageGenerationRequest } from '../../types';

describe('ResponseFormatAdapter Property Tests', () => {
  let adapter: ResponseFormatAdapter;

  beforeEach(() => {
    adapter = new ResponseFormatAdapter();
  });

  // Generators for test data
  const arbitraryProvider = fc.record({
    id: fc.string({ minLength: 1 }),
    name: fc.string(),
    baseUrl: fc.webUrl(),
    apiKey: fc.string({ minLength: 1 }),
    authType: fc.constantFrom('bearer', 'api_key', 'custom_header'),
    customHeaders: fc.option(fc.dictionary(fc.string(), fc.string()))
  }) as fc.Arbitrary<APIProvider>;

  const arbitraryImageRequest = fc.record({
    prompt: fc.string({ minLength: 1 }),
    model: fc.option(fc.string()),
    size: fc.option(fc.constantFrom('256x256', '512x512', '1024x1024', '1792x1024', '1024x1792')),
    quality: fc.option(fc.constantFrom('standard', 'hd')),
    response_format: fc.option(fc.constantFrom('url', 'b64_json', 'uri', 'base64')),
    n: fc.option(fc.integer({ min: 1, max: 10 }))
  }) as fc.Arbitrary<ImageGenerationRequest>;

  const arbitraryOpenAIResponse = fc.record({
    data: fc.array(fc.record({
      url: fc.option(fc.webUrl()),
      b64_json: fc.option(fc.string()),
      revised_prompt: fc.option(fc.string())
    }), { minLength: 1, maxLength: 5 }),
    usage: fc.option(fc.record({
      prompt_tokens: fc.option(fc.integer({ min: 0, max: 1000 })),
      completion_tokens: fc.option(fc.integer({ min: 0, max: 1000 })),
      total_tokens: fc.option(fc.integer({ min: 0, max: 2000 }))
    }))
  });

  const arbitraryDirectArrayResponse = fc.array(
    fc.oneof(
      fc.webUrl(),
      fc.record({
        url: fc.option(fc.webUrl()),
        image_url: fc.option(fc.webUrl()),
        b64_json: fc.option(fc.string()),
        base64: fc.option(fc.string()),
        revised_prompt: fc.option(fc.string()),
        prompt: fc.option(fc.string())
      })
    ),
    { minLength: 1, maxLength: 5 }
  );

  const arbitrarySingleImageResponse = fc.record({
    url: fc.option(fc.webUrl()),
    image_url: fc.option(fc.webUrl()),
    b64_json: fc.option(fc.string()),
    base64: fc.option(fc.string()),
    revised_prompt: fc.option(fc.string()),
    prompt: fc.option(fc.string())
  });

  /**
   * Property 4: Response format adaptation
   * **Validates: Requirements 3.1, 3.2, 3.3, 3.4**
   */
  describe('Feature: third-party-api-compatibility, Property 4: Response format adaptation', () => {
    it('should always produce valid request format for any input', () => {
      fc.assert(fc.property(
        arbitraryImageRequest,
        arbitraryProvider,
        (request, provider) => {
          const result = adapter.adaptRequestFormat(request, provider);
          
          // Result should always have a valid response_format
          expect(result.response_format).toBeDefined();
          expect(['url', 'b64_json']).toContain(result.response_format);
          
          // Original prompt should be preserved
          expect(result.prompt).toBe(request.prompt);
          
          // Image count should be reasonable (1-10)
          if (result.n !== undefined) {
            expect(result.n).toBeGreaterThanOrEqual(1);
            expect(result.n).toBeLessThanOrEqual(10);
          }
          
          // Size should be valid if present
          if (result.size) {
            expect(result.size).toMatch(/^\d+x\d+$/);
          }
          
          return true;
        }
      ), { numRuns: 100 });
    });

    it('should always produce standardized response format for OpenAI-style responses', () => {
      fc.assert(fc.property(
        arbitraryOpenAIResponse,
        arbitraryProvider,
        (response, provider) => {
          const result = adapter.adaptResponseFormat(response, provider);
          
          // Result should always have images array
          expect(Array.isArray(result.images)).toBe(true);
          
          // Each image should have valid structure
          result.images.forEach(image => {
            expect(typeof image).toBe('object');
            expect(image).not.toBeNull();
            
            // Should have at least one image property
            const hasImageData = image.url || image.b64_json;
            expect(hasImageData).toBeTruthy();
            
            // URL should be valid if present
            if (image.url) {
              expect(typeof image.url).toBe('string');
              expect(image.url.length).toBeGreaterThan(0);
            }
            
            // Base64 should be string if present
            if (image.b64_json) {
              expect(typeof image.b64_json).toBe('string');
            }
            
            // Revised prompt should be string if present
            if (image.revised_prompt) {
              expect(typeof image.revised_prompt).toBe('string');
            }
          });
          
          // Usage should be valid if present
          if (result.usage) {
            expect(typeof result.usage).toBe('object');
            if (result.usage.prompt_tokens !== undefined) {
              expect(typeof result.usage.prompt_tokens).toBe('number');
              expect(result.usage.prompt_tokens).toBeGreaterThanOrEqual(0);
            }
            if (result.usage.total_tokens !== undefined) {
              expect(typeof result.usage.total_tokens).toBe('number');
              expect(result.usage.total_tokens).toBeGreaterThanOrEqual(0);
            }
          }
          
          return true;
        }
      ), { numRuns: 100 });
    });

    it('should always produce standardized response format for direct array responses', () => {
      fc.assert(fc.property(
        arbitraryDirectArrayResponse,
        arbitraryProvider,
        (response, provider) => {
          const result = adapter.adaptResponseFormat(response, provider);
          
          // Result should always have images array
          expect(Array.isArray(result.images)).toBe(true);
          expect(result.images.length).toBeGreaterThan(0);
          
          // Number of images should match input array length
          expect(result.images.length).toBe(response.length);
          
          // Each image should have valid structure
          result.images.forEach((image, index) => {
            expect(typeof image).toBe('object');
            expect(image).not.toBeNull();
            
            const originalItem = response[index];
            
            // If original was a string, should be converted to URL
            if (typeof originalItem === 'string') {
              expect(image.url).toBe(originalItem);
            }
            
            // Should have at least one image property
            const hasImageData = image.url || image.b64_json;
            expect(hasImageData).toBeTruthy();
          });
          
          return true;
        }
      ), { numRuns: 100 });
    });

    it('should always produce standardized response format for single image responses', () => {
      fc.assert(fc.property(
        arbitrarySingleImageResponse,
        arbitraryProvider,
        (response, provider) => {
          // Skip if response has no image data
          const hasImageData = response.url || response.image_url || response.b64_json || response.base64;
          fc.pre(hasImageData);
          
          const result = adapter.adaptResponseFormat(response, provider);
          
          // Result should always have images array with one item
          expect(Array.isArray(result.images)).toBe(true);
          expect(result.images.length).toBe(1);
          
          const image = result.images[0];
          expect(typeof image).toBe('object');
          expect(image).not.toBeNull();
          
          // Should have at least one image property
          const resultHasImageData = image.url || image.b64_json;
          expect(resultHasImageData).toBeTruthy();
          
          // URL mapping should work correctly
          if (response.url || response.image_url) {
            expect(image.url).toBe(response.url || response.image_url);
          }
          
          // Base64 mapping should work correctly
          if (response.b64_json || response.base64) {
            expect(image.b64_json).toBe(response.b64_json || response.base64);
          }
          
          // Prompt mapping should work correctly
          if (response.revised_prompt || response.prompt) {
            expect(image.revised_prompt).toBe(response.revised_prompt || response.prompt);
          }
          
          return true;
        }
      ), { numRuns: 100 });
    });

    it('should preserve request properties that are not adapted', () => {
      fc.assert(fc.property(
        arbitraryImageRequest,
        arbitraryProvider,
        (request, provider) => {
          const result = adapter.adaptRequestFormat(request, provider);
          
          // Prompt should always be preserved exactly
          expect(result.prompt).toBe(request.prompt);
          
          // If model is not adapted, it should be preserved
          if (request.model && !['dalle-3', 'dalle-2', 'stable-diffusion', 'sdxl'].includes(request.model)) {
            expect(result.model).toBe(request.model);
          }
          
          return true;
        }
      ), { numRuns: 100 });
    });

    it('should handle provider name extraction consistently', () => {
      fc.assert(fc.property(
        arbitraryProvider,
        (provider) => {
          // Test with different request formats to ensure provider name extraction is consistent
          const request1 = { prompt: 'test1', response_format: 'url' as const };
          const request2 = { prompt: 'test2', response_format: 'b64_json' as const };
          
          const result1 = adapter.adaptRequestFormat(request1, provider);
          const result2 = adapter.adaptRequestFormat(request2, provider);
          
          // Provider-specific adaptations should be consistent
          // If model was adapted in first call, it should be adapted the same way in second call
          if (request1.model === request2.model) {
            expect(result1.model).toBe(result2.model);
          }
          
          return true;
        }
      ), { numRuns: 100 });
    });

    it('should always return valid supported formats list', () => {
      fc.assert(fc.asyncProperty(
        arbitraryProvider,
        async (provider) => {
          const formats = await adapter.detectSupportedFormats(provider);
          
          // Should always return an array
          expect(Array.isArray(formats)).toBe(true);
          
          // Should have at least one format
          expect(formats.length).toBeGreaterThan(0);
          
          // All formats should be valid strings
          formats.forEach(format => {
            expect(typeof format).toBe('string');
            expect(format.length).toBeGreaterThan(0);
          });
          
          // Should contain only known formats
          const knownFormats = ['url', 'b64_json'];
          formats.forEach(format => {
            expect(knownFormats).toContain(format);
          });
          
          return true;
        }
      ), { numRuns: 50 }); // Fewer runs for async tests
    });

    it('should validate response format consistently', () => {
      fc.assert(fc.property(
        fc.oneof(
          arbitraryOpenAIResponse,
          arbitraryDirectArrayResponse,
          arbitrarySingleImageResponse,
          fc.constant(null),
          fc.constant(undefined),
          fc.record({ someOtherProperty: fc.string() })
        ),
        (response) => {
          const result = adapter.validateResponseFormat(response);
          
          // Result should always have required properties
          expect(typeof result.isValid).toBe('boolean');
          expect(Array.isArray(result.issues)).toBe(true);
          
          // Issues should be strings
          result.issues.forEach(issue => {
            expect(typeof issue).toBe('string');
            expect(issue.length).toBeGreaterThan(0);
          });
          
          // If invalid, should have at least one issue
          if (!result.isValid) {
            expect(result.issues.length).toBeGreaterThan(0);
          }
          
          // Suggested fix should be string if present
          if (result.suggestedFix) {
            expect(typeof result.suggestedFix).toBe('string');
            expect(result.suggestedFix.length).toBeGreaterThan(0);
          }
          
          return true;
        }
      ), { numRuns: 100 });
    });
  });

  describe('Error handling properties', () => {
    it('should never throw for any valid provider and request combination', () => {
      fc.assert(fc.property(
        arbitraryImageRequest,
        arbitraryProvider,
        (request, provider) => {
          expect(() => {
            adapter.adaptRequestFormat(request, provider);
          }).not.toThrow();
          
          return true;
        }
      ), { numRuns: 100 });
    });

    it('should never throw for any response and provider combination', () => {
      fc.assert(fc.property(
        fc.anything(),
        arbitraryProvider,
        (response, provider) => {
          // Skip null/undefined responses as they should throw
          fc.pre(response !== null && response !== undefined);
          
          expect(() => {
            adapter.adaptResponseFormat(response, provider);
          }).not.toThrow();
          
          return true;
        }
      ), { numRuns: 100 });
    });

    it('should handle malformed responses gracefully', () => {
      fc.assert(fc.property(
        fc.oneof(
          fc.record({ data: fc.string() }), // data should be array
          fc.record({ data: fc.integer() }), // data should be array
          fc.record({ data: fc.array(fc.string()) }), // array of strings instead of objects
          fc.record({ usage: fc.string() }), // usage should be object
          fc.record({ error: fc.string() }) // error should be object
        ),
        arbitraryProvider,
        (malformedResponse, provider) => {
          const result = adapter.adaptResponseFormat(malformedResponse, provider);
          
          // Should always return a valid response structure
          expect(typeof result).toBe('object');
          expect(result).not.toBeNull();
          expect(Array.isArray(result.images)).toBe(true);
          
          // Should handle errors gracefully
          if (result.error) {
            expect(typeof result.error.message).toBe('string');
          }
          
          return true;
        }
      ), { numRuns: 100 });
    });
  });
});