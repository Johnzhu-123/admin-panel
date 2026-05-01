import { FallbackStrategyImpl } from '../fallback-strategy';
import { APIError, ImageGenerationRequest, FallbackResult } from '../../types';
import { FallbackHandler } from '../../interfaces';

describe('FallbackStrategyImpl', () => {
  let fallbackStrategy: FallbackStrategyImpl;

  beforeEach(() => {
    fallbackStrategy = new FallbackStrategyImpl();
  });

  describe('executeFallback', () => {
    it('should execute appropriate fallback for path errors', async () => {
      const request: ImageGenerationRequest = {
        prompt: 'test prompt',
        response_format: 'url',
      };

      const error: APIError = {
        type: 'path_error',
        code: '404',
        message: 'Not found',
        provider: 'test-provider',
        timestamp: new Date(),
        request,
      };

      const result = await fallbackStrategy.executeFallback(request, error);

      expect(result.originalError).toBe(error);
      expect(result.fallbackUsed).toBeDefined();
    });

    it('should execute chat fallback for content policy errors', async () => {
      const request: ImageGenerationRequest = {
        prompt: 'inappropriate content',
        response_format: 'url',
      };

      const error: APIError = {
        type: 'content_policy',
        code: 'content_policy_violation',
        message: 'Content violates policy',
        provider: 'test-provider',
        timestamp: new Date(),
        request,
      };

      const result = await fallbackStrategy.executeFallback(request, error);

      expect(result.originalError).toBe(error);
      expect(result.fallbackUsed).toBe('chat_fallback');
      expect(result.success).toBe(true);
      expect(result.result?.images).toHaveLength(1);
      expect(result.result?.images[0].revised_prompt).toContain('Unable to generate image');
    });

    it('should return failure when no fallback handlers can handle the error', async () => {
      const request: ImageGenerationRequest = {
        prompt: 'test prompt',
      };

      const error: APIError = {
        type: 'unknown',
        code: 'unknown_error',
        message: 'Unknown error',
        provider: 'test-provider',
        timestamp: new Date(),
        request,
      };

      const result = await fallbackStrategy.executeFallback(request, error);

      expect(result.success).toBe(false);
      expect(result.fallbackUsed).toBe('none');
      expect(result.originalError).toBe(error);
    });
  });

  describe('registerFallbackHandler', () => {
    it('should register a custom fallback handler', async () => {
      // Create a fresh instance without default handlers
      const freshStrategy = new FallbackStrategyImpl(false);
      
      const customHandler: FallbackHandler = {
        canHandle: (error) => error.type === 'path_error',
        execute: async (request, error) => ({
          success: true,
          fallbackUsed: 'custom_handler',
          originalError: error,
          result: {
            images: [{ url: 'http://example.com/fallback.jpg' }],
          },
        }),
      };

      freshStrategy.registerFallbackHandler('custom_handler', customHandler);

      const request: ImageGenerationRequest = {
        prompt: 'test prompt',
      };

      const error: APIError = {
        type: 'path_error',
        code: 'custom',
        message: 'Custom error',
        provider: 'test-provider',
        timestamp: new Date(),
        request,
      };

      const result = await freshStrategy.executeFallback(request, error);

      expect(result.success).toBe(true);
      expect(result.fallbackUsed).toBe('custom_handler');
      expect(result.result?.images[0].url).toBe('http://example.com/fallback.jpg');
    });
  });

  describe('getFallbackOptions', () => {
    it('should return all available fallback options', () => {
      const provider = {
        id: 'test-provider',
        name: 'Test Provider',
        baseUrl: 'https://api.test.com',
        apiKey: 'test-key',
        authType: 'bearer' as const,
      };

      const options = fallbackStrategy.getFallbackOptions(provider);

      expect(options).toHaveLength(6);
      expect(options.map(o => o.id)).toContain('path_retry');
      expect(options.map(o => o.id)).toContain('format_fallback');
      expect(options.map(o => o.id)).toContain('auth_retry');
      expect(options.map(o => o.id)).toContain('chat_fallback');
      expect(options.map(o => o.id)).toContain('network_retry');
      expect(options.map(o => o.id)).toContain('rate_limit_backoff');
    });

    it('should return options sorted by priority', () => {
      const provider = {
        id: 'test-provider',
        name: 'Test Provider',
        baseUrl: 'https://api.test.com',
        apiKey: 'test-key',
        authType: 'bearer' as const,
      };

      const options = fallbackStrategy.getFallbackOptions(provider);

      for (let i = 1; i < options.length; i++) {
        expect(options[i].priority).toBeGreaterThanOrEqual(options[i - 1].priority);
      }
    });
  });

  describe('getFallbackStats', () => {
    it('should return empty stats initially', () => {
      const stats = fallbackStrategy.getFallbackStats();
      
      // Should have stats for default handlers but with zero usage
      expect(Object.keys(stats)).toContain('path_retry');
      expect(stats.path_retry.used).toBe(0);
      expect(stats.path_retry.success).toBe(0);
      expect(stats.path_retry.successRate).toBe(0);
    });

    it('should track fallback usage statistics', async () => {
      const request: ImageGenerationRequest = {
        prompt: 'test prompt',
      };

      const error: APIError = {
        type: 'content_policy',
        code: 'policy_violation',
        message: 'Policy violation',
        provider: 'test-provider',
        timestamp: new Date(),
        request,
      };

      // Execute fallback to generate stats
      await fallbackStrategy.executeFallback(request, error);

      const stats = fallbackStrategy.getFallbackStats();
      
      expect(stats.chat_fallback.used).toBe(1);
      expect(stats.chat_fallback.success).toBe(1);
      expect(stats.chat_fallback.successRate).toBe(1);
    });
  });

  describe('clearStats', () => {
    it('should clear all fallback statistics', async () => {
      const request: ImageGenerationRequest = {
        prompt: 'test prompt',
      };

      const error: APIError = {
        type: 'content_policy',
        code: 'policy_violation',
        message: 'Policy violation',
        provider: 'test-provider',
        timestamp: new Date(),
        request,
      };

      // Execute fallback to generate stats
      await fallbackStrategy.executeFallback(request, error);

      // Verify stats exist
      let stats = fallbackStrategy.getFallbackStats();
      expect(stats.chat_fallback.used).toBe(1);

      // Clear stats
      fallbackStrategy.clearStats();

      // Verify stats are cleared
      stats = fallbackStrategy.getFallbackStats();
      expect(Object.keys(stats)).toHaveLength(0);
    });
  });

  describe('fallback option canHandle logic', () => {
    it('should correctly identify which errors each fallback can handle', () => {
      const provider = {
        id: 'test-provider',
        name: 'Test Provider',
        baseUrl: 'https://api.test.com',
        apiKey: 'test-key',
        authType: 'bearer' as const,
      };

      const options = fallbackStrategy.getFallbackOptions(provider);

      // Test path_retry
      const pathRetry = options.find(o => o.id === 'path_retry')!;
      expect(pathRetry.canHandle({ type: 'path_error' } as APIError)).toBe(true);
      expect(pathRetry.canHandle({ type: 'auth_error' } as APIError)).toBe(false);

      // Test format_fallback
      const formatFallback = options.find(o => o.id === 'format_fallback')!;
      expect(formatFallback.canHandle({ type: 'format_error' } as APIError)).toBe(true);
      expect(formatFallback.canHandle({ type: 'network_error' } as APIError)).toBe(false);

      // Test chat_fallback (handles multiple error types)
      const chatFallback = options.find(o => o.id === 'chat_fallback')!;
      expect(chatFallback.canHandle({ type: 'path_error' } as APIError)).toBe(true);
      expect(chatFallback.canHandle({ type: 'format_error' } as APIError)).toBe(true);
      expect(chatFallback.canHandle({ type: 'content_policy' } as APIError)).toBe(true);
      expect(chatFallback.canHandle({ type: 'auth_error' } as APIError)).toBe(false);

      // Test rate_limit_backoff
      const rateLimitBackoff = options.find(o => o.id === 'rate_limit_backoff')!;
      expect(rateLimitBackoff.canHandle({ type: 'rate_limit' } as APIError)).toBe(true);
      expect(rateLimitBackoff.canHandle({ type: 'network_error' } as APIError)).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle empty prompt gracefully', async () => {
      const request: ImageGenerationRequest = {
        prompt: '',
      };

      const error: APIError = {
        type: 'content_policy',
        code: 'empty_prompt',
        message: 'Empty prompt',
        provider: 'test-provider',
        timestamp: new Date(),
        request,
      };

      const result = await fallbackStrategy.executeFallback(request, error);

      expect(result.success).toBe(true);
      expect(result.result?.images[0].revised_prompt).toContain('Unable to generate image');
    });

    it('should handle missing request properties', async () => {
      const request: ImageGenerationRequest = {
        prompt: 'test prompt',
        // Missing optional properties
      };

      const error: APIError = {
        type: 'format_error',
        code: 'invalid_format',
        message: 'Invalid format',
        provider: 'test-provider',
        timestamp: new Date(),
        request,
      };

      const result = await fallbackStrategy.executeFallback(request, error);

      expect(result.originalError).toBe(error);
      expect(result.fallbackUsed).toBeDefined();
    });
  });
});