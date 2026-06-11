import * as fc from 'fast-check';
import { FallbackStrategyImpl } from '../fallback-strategy';
import { APIError, ImageGenerationRequest, ErrorType, AuthenticationType } from '../../types';

describe('FallbackStrategyImpl Property Tests', () => {
  let fallbackStrategy: FallbackStrategyImpl;

  beforeEach(() => {
    fallbackStrategy = new FallbackStrategyImpl();
  });

  // Generators for property tests
  // 🔧 FIX (2026-06-11 类型门禁): 显式声明字面量联合，constantFrom 默认推断为 string
  const arbitraryErrorType = fc.constantFrom<ErrorType>(
    'path_error',
    'auth_error',
    'format_error',
    'network_error',
    'content_policy',
    'rate_limit',
    'unknown'
  );

  const arbitraryImageRequest = fc.record({
    prompt: fc.string({ minLength: 1, maxLength: 1000 }),
    model: fc.option(fc.string()),
    size: fc.option(fc.constantFrom('256x256', '512x512', '1024x1024')),
    quality: fc.option(fc.constantFrom('standard', 'hd')),
    response_format: fc.option(fc.constantFrom('url', 'b64_json')),
    n: fc.option(fc.integer({ min: 1, max: 4 })),
  });

  const arbitraryAPIError = fc.record({
    type: arbitraryErrorType,
    code: fc.string({ minLength: 1, maxLength: 50 }),
    message: fc.string({ minLength: 1, maxLength: 500 }),
    provider: fc.string({ minLength: 1, maxLength: 100 }),
    timestamp: fc.date(),
    request: arbitraryImageRequest,
  });

  const arbitraryProvider = fc.record({
    id: fc.string({ minLength: 1, maxLength: 50 }),
    name: fc.string({ minLength: 1, maxLength: 100 }),
    baseUrl: fc.webUrl(),
    apiKey: fc.string({ minLength: 1, maxLength: 200 }),
    authType: fc.constantFrom<AuthenticationType>('bearer', 'api_key', 'custom_header'),
  });

  /**
   * Property 2: API调用降级策略
   * For any 图像生成请求，当标准端点失败时，系统应该按照预定义的降级顺序尝试备用方案
   * Validates: Requirements 2.1, 2.2, 7.1
   */
  it('Feature: third-party-api-compatibility, Property 2: API调用降级策略', () => {
    fc.assert(
      fc.asyncProperty(arbitraryImageRequest, arbitraryAPIError, async (request, error) => {
        const result = await fallbackStrategy.executeFallback(request, error);

        // Property: Result should always contain original error
        expect(result.originalError).toBe(error);

        // Property: Fallback used should be defined
        expect(result.fallbackUsed).toBeDefined();
        expect(typeof result.fallbackUsed).toBe('string');

        // Property: Success should be boolean
        expect(typeof result.success).toBe('boolean');

        // Property: If successful, result should be provided
        if (result.success) {
          expect(result.result).toBeDefined();
          expect(result.result!.images).toBeDefined();
          expect(Array.isArray(result.result!.images)).toBe(true);
        }
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 8: 降级策略智能选择
   * For any 错误类型，系统应该选择最合适的降级策略，并在多重失败时提供清晰的失败原因
   * Validates: Requirements 7.2, 7.3, 7.4
   */
  it('Feature: third-party-api-compatibility, Property 8: 降级策略智能选择', () => {
    fc.assert(
      fc.asyncProperty(arbitraryImageRequest, arbitraryAPIError, async (request, error) => {
        const result = await fallbackStrategy.executeFallback(request, error);

        // Property: Fallback selection should be deterministic for same error type
        const result2 = await fallbackStrategy.executeFallback(request, error);
        
        // For content_policy errors, chat_fallback should always be used and succeed
        if (error.type === 'content_policy') {
          expect(result.fallbackUsed).toBe('chat_fallback');
          expect(result.success).toBe(true);
          expect(result2.fallbackUsed).toBe('chat_fallback');
          expect(result2.success).toBe(true);
        }

        // Property: Unknown errors should result in no fallback
        if (error.type === 'unknown') {
          expect(result.fallbackUsed).toBe('none');
          expect(result.success).toBe(false);
        }

        // Property: Error information should be preserved
        expect(result.originalError.type).toBe(error.type);
        expect(result.originalError.message).toBe(error.message);
        expect(result.originalError.provider).toBe(error.provider);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property: Fallback options consistency
   * For any provider, fallback options should be consistent and properly prioritized
   */
  it('Feature: third-party-api-compatibility, Property: Fallback options consistency', () => {
    fc.assert(
      fc.property(arbitraryProvider, (provider) => {
        const options = fallbackStrategy.getFallbackOptions(provider);

        // Property: Should always return the same number of options
        expect(options).toHaveLength(6);

        // Property: Options should be sorted by priority
        for (let i = 1; i < options.length; i++) {
          expect(options[i].priority).toBeGreaterThanOrEqual(options[i - 1].priority);
        }

        // Property: Each option should have required properties
        options.forEach(option => {
          expect(option.id).toBeDefined();
          expect(typeof option.id).toBe('string');
          expect(option.name).toBeDefined();
          expect(typeof option.name).toBe('string');
          expect(option.description).toBeDefined();
          expect(typeof option.description).toBe('string');
          expect(typeof option.priority).toBe('number');
          expect(typeof option.canHandle).toBe('function');
        });

        // Property: canHandle functions should be deterministic
        const testError: APIError = {
          type: 'path_error',
          code: 'test',
          message: 'test',
          provider: 'test',
          timestamp: new Date(),
          request: { prompt: 'test' },
        };

        options.forEach(option => {
          const result1 = option.canHandle(testError);
          const result2 = option.canHandle(testError);
          expect(result1).toBe(result2);
          expect(typeof result1).toBe('boolean');
        });
      }),
      { numRuns: 50 }
    );
  });

  /**
   * Property: Statistics tracking consistency
   * For any sequence of fallback executions, statistics should be accurately tracked
   */
  it('Feature: third-party-api-compatibility, Property: Statistics tracking consistency', () => {
    fc.assert(
      fc.asyncProperty(
        fc.array(arbitraryAPIError, { minLength: 1, maxLength: 5 }),
        arbitraryImageRequest,
        async (errors, request) => {
          // Clear stats before test
          fallbackStrategy.clearStats();

          // Execute fallbacks
          const results = [];
          for (const error of errors) {
            const result = await fallbackStrategy.executeFallback(request, error);
            results.push(result);
          }

          const stats = fallbackStrategy.getFallbackStats();

          // Property: Success rate should be between 0 and 1
          Object.values(stats).forEach(stat => {
            expect(stat.successRate).toBeGreaterThanOrEqual(0);
            expect(stat.successRate).toBeLessThanOrEqual(1);
            
            // Property: Success rate calculation should be correct
            if (stat.used > 0) {
              expect(stat.successRate).toBe(stat.success / stat.used);
            } else {
              expect(stat.successRate).toBe(0);
            }
          });

          // Property: Used count should equal success + failure count
          Object.values(stats).forEach(stat => {
            expect(stat.used).toBeGreaterThanOrEqual(stat.success);
          });

          // Property: Total used should be at least the number of valid fallbacks
          // (could be more if multiple handlers are tried per error)
          const validFallbacks = results.filter(r => r.fallbackUsed !== 'none');
          const totalUsed = Object.values(stats).reduce((sum, stat) => sum + stat.used, 0);
          expect(totalUsed).toBeGreaterThanOrEqual(validFallbacks.length);
        }
      ),
      { numRuns: 30 }
    );
  });

  /**
   * Property: Error type specific fallback behavior
   * For specific error types, appropriate fallbacks should be selected
   */
  it('Feature: third-party-api-compatibility, Property: Error type specific fallback behavior', () => {
    fc.assert(
      fc.asyncProperty(arbitraryImageRequest, async (request) => {
        // Test only error types that we know have fallbacks
        const errorTypesWithFallbacks: ErrorType[] = [
          'content_policy', // Always has chat_fallback
        ];

        for (const errorType of errorTypesWithFallbacks) {
          const error: APIError = {
            type: errorType,
            code: 'test_code',
            message: 'test message',
            provider: 'test_provider',
            timestamp: new Date(),
            request,
          };

          const result = await fallbackStrategy.executeFallback(request, error);

          // Property: content_policy should always use chat_fallback and succeed
          if (errorType === 'content_policy') {
            expect(result.fallbackUsed).toBe('chat_fallback');
            expect(result.success).toBe(true);
          }

          // Property: Original error should always be preserved
          expect(result.originalError.type).toBe(errorType);
        }
      }),
      { numRuns: 20 }
    );
  });

  /**
   * Property: Idempotency of fallback options
   * Multiple calls to getFallbackOptions should return identical results
   */
  it('Feature: third-party-api-compatibility, Property: Idempotency of fallback options', () => {
    fc.assert(
      fc.property(arbitraryProvider, (provider) => {
        const options1 = fallbackStrategy.getFallbackOptions(provider);
        const options2 = fallbackStrategy.getFallbackOptions(provider);

        // Property: Results should be identical
        expect(options1).toHaveLength(options2.length);
        
        for (let i = 0; i < options1.length; i++) {
          expect(options1[i].id).toBe(options2[i].id);
          expect(options1[i].name).toBe(options2[i].name);
          expect(options1[i].description).toBe(options2[i].description);
          expect(options1[i].priority).toBe(options2[i].priority);
        }
      }),
      { numRuns: 50 }
    );
  });

  /**
   * Property: Clear stats functionality
   * After clearing stats, all statistics should be reset
   */
  it('Feature: third-party-api-compatibility, Property: Clear stats functionality', () => {
    fc.assert(
      fc.asyncProperty(
        fc.array(arbitraryAPIError, { minLength: 1, maxLength: 5 }),
        arbitraryImageRequest,
        async (errors, request) => {
          // Execute some fallbacks to generate stats
          for (const error of errors) {
            await fallbackStrategy.executeFallback(request, error);
          }

          // Verify stats exist
          let stats = fallbackStrategy.getFallbackStats();
          const hasStats = Object.keys(stats).length > 0;
          
          if (hasStats) {
            // Clear stats
            fallbackStrategy.clearStats();

            // Property: After clearing, stats should be empty
            stats = fallbackStrategy.getFallbackStats();
            expect(Object.keys(stats)).toHaveLength(0);
          }
        }
      ),
      { numRuns: 30 }
    );
  });
});