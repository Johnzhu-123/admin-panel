// Unit tests for Response Format Adapter

import { ResponseFormatAdapter } from '../response-format-adapter';
import { APIProvider, ImageGenerationRequest, ImageGenerationResponse } from '../../types';

describe('ResponseFormatAdapter', () => {
  let adapter: ResponseFormatAdapter;
  let mockProvider: APIProvider;

  beforeEach(() => {
    adapter = new ResponseFormatAdapter();
    mockProvider = {
      id: 'test-provider',
      name: 'Test Provider',
      baseUrl: 'https://api.test.com',
      apiKey: 'test-key',
      authType: 'bearer'
    };
  });

  describe('adaptRequestFormat', () => {
    it('should throw error for missing request or provider', () => {
      expect(() => adapter.adaptRequestFormat(null as any, mockProvider)).toThrow('Request and provider are required');
      expect(() => adapter.adaptRequestFormat({} as any, null as any)).toThrow('Request and provider are required');
    });

    it('should set default response_format when not specified', () => {
      const request: ImageGenerationRequest = {
        prompt: 'test prompt'
      };

      const result = adapter.adaptRequestFormat(request, mockProvider);
      
      expect(result.response_format).toBeDefined();
      expect(['url', 'b64_json']).toContain(result.response_format);
    });

    it('should preserve valid response_format', () => {
      const request: ImageGenerationRequest = {
        prompt: 'test prompt',
        response_format: 'url'
      };

      const result = adapter.adaptRequestFormat(request, mockProvider);
      
      expect(result.response_format).toBe('url');
    });

    it('should adapt unsupported format to compatible one', () => {
      const request: ImageGenerationRequest = {
        prompt: 'test prompt',
        response_format: 'uri' // Should be mapped to 'url'
      };

      const result = adapter.adaptRequestFormat(request, mockProvider);
      
      expect(result.response_format).toBe('url');
    });

    it('should adapt model name for known providers', () => {
      const openaiProvider: APIProvider = {
        ...mockProvider,
        name: 'OpenAI',
        baseUrl: 'https://api.openai.com'
      };

      const request: ImageGenerationRequest = {
        prompt: 'test prompt',
        model: 'dalle-3'
      };

      const result = adapter.adaptRequestFormat(request, openaiProvider);
      
      expect(result.model).toBe('dall-e-3');
    });

    it('should adapt image size for provider compatibility', () => {
      const stabilityProvider: APIProvider = {
        ...mockProvider,
        name: 'Stability AI',
        baseUrl: 'https://api.stability.ai'
      };

      const request: ImageGenerationRequest = {
        prompt: 'test prompt',
        size: '256x256' // Should be mapped to 512x512 for Stability
      };

      const result = adapter.adaptRequestFormat(request, stabilityProvider);
      
      expect(result.size).toBe('512x512');
    });

    it('should limit image count based on provider limits', () => {
      const stabilityProvider: APIProvider = {
        ...mockProvider,
        name: 'Stability AI'
      };

      const request: ImageGenerationRequest = {
        prompt: 'test prompt',
        n: 5 // Should be limited to 1 for Stability
      };

      const result = adapter.adaptRequestFormat(request, stabilityProvider);
      
      expect(result.n).toBe(1);
    });

    it('should remove quality parameter for unsupported providers', () => {
      const stabilityProvider: APIProvider = {
        ...mockProvider,
        name: 'Stability AI'
      };

      const request: ImageGenerationRequest = {
        prompt: 'test prompt',
        quality: 'hd'
      };

      const result = adapter.adaptRequestFormat(request, stabilityProvider);
      
      expect(result.quality).toBeUndefined();
    });
  });

  describe('adaptResponseFormat', () => {
    it('should return error response for missing response', () => {
      const result = adapter.adaptResponseFormat(null, mockProvider);
      expect(result.error).toBeDefined();
      expect(result.error?.message).toBe('Response is required');
      expect(result.images).toHaveLength(0);
    });

    it('should handle OpenAI-style response with data array', () => {
      const response = {
        data: [
          {
            url: 'https://example.com/image1.png',
            revised_prompt: 'revised prompt'
          },
          {
            b64_json: 'base64data',
            revised_prompt: 'another revised prompt'
          }
        ],
        usage: {
          prompt_tokens: 10,
          total_tokens: 10
        }
      };

      const result = adapter.adaptResponseFormat(response, mockProvider);
      
      expect(result.images).toHaveLength(2);
      expect(result.images[0].url).toBe('https://example.com/image1.png');
      expect(result.images[0].revised_prompt).toBe('revised prompt');
      expect(result.images[1].b64_json).toBe('base64data');
      expect(result.usage?.prompt_tokens).toBe(10);
      expect(result.usage?.total_tokens).toBe(10);
    });

    it('should handle direct array response', () => {
      const response = [
        'https://example.com/image1.png',
        {
          url: 'https://example.com/image2.png',
          prompt: 'test prompt'
        }
      ];

      const result = adapter.adaptResponseFormat(response, mockProvider);
      
      expect(result.images).toHaveLength(2);
      expect(result.images[0].url).toBe('https://example.com/image1.png');
      expect(result.images[1].url).toBe('https://example.com/image2.png');
      expect(result.images[1].revised_prompt).toBe('test prompt');
    });

    it('should handle single image response', () => {
      const response = {
        url: 'https://example.com/image.png',
        revised_prompt: 'single image'
      };

      const result = adapter.adaptResponseFormat(response, mockProvider);
      
      expect(result.images).toHaveLength(1);
      expect(result.images[0].url).toBe('https://example.com/image.png');
      expect(result.images[0].revised_prompt).toBe('single image');
    });

    it('should handle response with error', () => {
      const response = {
        error: {
          message: 'Content policy violation',
          code: 'content_policy_violation',
          type: 'invalid_request_error'
        }
      };

      const result = adapter.adaptResponseFormat(response, mockProvider);
      
      expect(result.images).toHaveLength(0);
      expect(result.error?.message).toBe('Content policy violation');
      expect(result.error?.code).toBe('content_policy_violation');
      expect(result.error?.type).toBe('invalid_request_error');
    });

    it('should handle alternative property names - debug', () => {
      // Simple test first
      const simpleResponse = {
        data: [
          {
            url: 'https://example.com/simple.png'
          }
        ]
      };

      const simpleResult = adapter.adaptResponseFormat(simpleResponse, mockProvider);
      expect(simpleResult.images).toHaveLength(1);
      expect(simpleResult.images[0].url).toBe('https://example.com/simple.png');
      
      // Now test with image_url
      const imageUrlResponse = {
        data: [
          {
            image_url: 'https://example.com/image_url.png'
          }
        ]
      };

      const imageUrlResult = adapter.adaptResponseFormat(imageUrlResponse, mockProvider);
      expect(imageUrlResult.images).toHaveLength(1);
      expect(imageUrlResult.images[0].url).toBe('https://example.com/image_url.png');
    });

    it('should return error response when adaptation fails', () => {
      // Mock console.warn to avoid test output
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      
      // Create a response that will cause extraction to fail by making the extractImages method throw
      const originalExtractImages = (adapter as any).extractImages;
      (adapter as any).extractImages = jest.fn().mockImplementation(() => {
        throw new Error('Test extraction error');
      });

      const response = {
        data: [{ url: 'https://example.com/image.png' }]
      };

      const result = adapter.adaptResponseFormat(response, mockProvider);
      
      expect(result.images).toHaveLength(0);
      expect(result.error?.message).toContain('Failed to adapt response format');
      expect(result.error?.code).toBe('format_adaptation_error');
      
      // Restore original method
      (adapter as any).extractImages = originalExtractImages;
      consoleSpy.mockRestore();
    });
  });

  describe('detectSupportedFormats', () => {
    it('should return default format for invalid provider', async () => {
      const result = await adapter.detectSupportedFormats(null as any);
      
      expect(result).toEqual(['url']);
    });

    it('should return known formats for recognized providers', async () => {
      const openaiProvider: APIProvider = {
        ...mockProvider,
        name: 'OpenAI',
        baseUrl: 'https://api.openai.com'
      };

      const result = await adapter.detectSupportedFormats(openaiProvider);
      
      expect(result).toContain('url');
      expect(result).toContain('b64_json');
    });

    it('should detect provider from base URL', async () => {
      const stabilityProvider: APIProvider = {
        ...mockProvider,
        name: 'Unknown',
        baseUrl: 'https://api.stability.ai'
      };

      const result = await adapter.detectSupportedFormats(stabilityProvider);
      
      expect(result).toContain('b64_json');
    });

    it('should cache detected formats', async () => {
      const customProvider: APIProvider = {
        ...mockProvider,
        name: 'Custom Provider'
      };

      // First call
      const result1 = await adapter.detectSupportedFormats(customProvider);
      
      // Second call should return cached result
      const result2 = await adapter.detectSupportedFormats(customProvider);
      
      expect(result1).toEqual(result2);
    });
  });

  describe('validateResponseFormat', () => {
    it('should validate null response as invalid', () => {
      const result = adapter.validateResponseFormat(null);
      
      expect(result.isValid).toBe(false);
      expect(result.issues).toContain('Response is null or undefined');
    });

    it('should validate OpenAI-style response as valid', () => {
      const response = {
        data: [
          { url: 'https://example.com/image.png' }
        ]
      };

      const result = adapter.validateResponseFormat(response);
      
      expect(result.isValid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should validate direct array response as valid', () => {
      const response = ['https://example.com/image.png'];

      const result = adapter.validateResponseFormat(response);
      
      expect(result.isValid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should validate single image response as valid', () => {
      const response = {
        url: 'https://example.com/image.png'
      };

      const result = adapter.validateResponseFormat(response);
      
      expect(result.isValid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should detect unrecognizable response structure', () => {
      const response = {
        someOtherProperty: 'value'
      };

      const result = adapter.validateResponseFormat(response);
      
      expect(result.isValid).toBe(false);
      expect(result.issues).toContain('Response does not contain recognizable image data structure');
      expect(result.suggestedFix).toBeDefined();
    });

    it('should detect error in response', () => {
      const response = {
        data: [{ url: 'https://example.com/image.png' }],
        error: { message: 'Some error' }
      };

      const result = adapter.validateResponseFormat(response);
      
      expect(result.isValid).toBe(true); // Still valid structure
      expect(result.issues).toContain('Response contains error information');
    });
  });

  describe('edge cases', () => {
    it('should handle empty request gracefully', () => {
      const request: ImageGenerationRequest = {
        prompt: ''
      };

      const result = adapter.adaptRequestFormat(request, mockProvider);
      
      expect(result.prompt).toBe('');
      expect(result.response_format).toBeDefined();
    });

    it('should handle provider with no name or ID', () => {
      const anonymousProvider: APIProvider = {
        id: '',
        name: '',
        baseUrl: 'https://api.unknown.com',
        apiKey: 'test-key',
        authType: 'bearer'
      };

      const request: ImageGenerationRequest = {
        prompt: 'test prompt'
      };

      const result = adapter.adaptRequestFormat(request, anonymousProvider);
      
      expect(result.response_format).toBeDefined();
    });

    it('should handle malformed response gracefully', () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      
      const malformedResponse = {
        data: 'not an array'
      };

      const result = adapter.adaptResponseFormat(malformedResponse, mockProvider);
      
      // The malformed response will be treated as a single image response with data property
      // Since 'data' is a string, it will be treated as b64_json
      expect(result.images).toHaveLength(1);
      expect(result.images[0].b64_json).toBe('not an array');
      
      consoleSpy.mockRestore();
    });

    it('should handle circular reference in response', () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      
      const circularResponse: any = {
        data: []
      };
      circularResponse.data.push(circularResponse); // Create circular reference

      const result = adapter.adaptResponseFormat(circularResponse, mockProvider);
      
      // Should not crash and return some result
      expect(result).toBeDefined();
      expect(result.images).toBeDefined();
      
      consoleSpy.mockRestore();
    });
  });
});