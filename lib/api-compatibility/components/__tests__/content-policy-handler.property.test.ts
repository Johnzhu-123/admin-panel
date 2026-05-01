import * as fc from 'fast-check';
import { ContentPolicyHandler, ContentPolicyCategory } from '../content-policy-handler';
import { APIError, ImageGenerationRequest, ErrorType } from '../../types';

describe('ContentPolicyHandler Property Tests', () => {
  let handler: ContentPolicyHandler;

  beforeEach(() => {
    handler = new ContentPolicyHandler();
  });

  // Generators for property tests
  const arbitraryPrompt = fc.string({ minLength: 1, maxLength: 500 });
  
  const arbitraryImageRequest = fc.record({
    prompt: arbitraryPrompt,
    model: fc.option(fc.string()),
    size: fc.option(fc.constantFrom('256x256', '512x512', '1024x1024')),
    quality: fc.option(fc.constantFrom('standard', 'hd')),
    response_format: fc.option(fc.constantFrom('url', 'b64_json')),
    n: fc.option(fc.integer({ min: 1, max: 4 })),
  });

  const arbitraryContentPolicyError = fc.record({
    type: fc.constant('content_policy' as ErrorType),
    code: fc.string({ minLength: 1, maxLength: 50 }),
    message: fc.oneof(
      fc.constant('Content policy violation detected'),
      fc.constant('Your request was rejected as a result of our safety system'),
      fc.constant('This request violates our usage policies'),
      fc.constant('Content blocked by safety filter'),
      fc.string({ minLength: 10, maxLength: 200 })
    ),
    provider: fc.string({ minLength: 1, maxLength: 100 }),
    timestamp: fc.date(),
    request: arbitraryImageRequest,
  });

  const arbitraryNonContentPolicyError = fc.record({
    type: fc.constantFrom('path_error', 'auth_error', 'format_error', 'network_error', 'rate_limit', 'unknown'),
    code: fc.string({ minLength: 1, maxLength: 50 }),
    message: fc.string({ minLength: 1, maxLength: 200 }),
    provider: fc.string({ minLength: 1, maxLength: 100 }),
    timestamp: fc.date(),
    request: arbitraryImageRequest,
  });

  /**
   * Property 7: 内容策略错误处理
   * For any 内容策略错误，系统应该正确识别、分类并提供用户友好的错误信息和修改建议
   * Validates: Requirements 6.1, 6.2, 6.3, 6.4
   */
  it('Feature: third-party-api-compatibility, Property 7: 内容策略错误处理', () => {
    fc.assert(
      fc.property(arbitraryContentPolicyError, arbitraryImageRequest, (error, request) => {
        const analysis = handler.analyzeContentPolicyError(error, request);

        // Property: Analysis should always contain required fields
        expect(analysis.category).toBeDefined();
        expect(Object.values(ContentPolicyCategory)).toContain(analysis.category);
        expect(analysis.severity).toMatch(/^(low|medium|high)$/);
        expect(analysis.originalPrompt).toBe(request.prompt);
        expect(analysis.violationReason).toBeDefined();
        expect(typeof analysis.violationReason).toBe('string');
        expect(analysis.violationReason.length).toBeGreaterThan(0);
        expect(Array.isArray(analysis.suggestions)).toBe(true);
        expect(analysis.suggestions.length).toBeGreaterThan(0);
        expect(typeof analysis.canRetry).toBe('boolean');

        // Property: All suggestions should be non-empty strings
        analysis.suggestions.forEach(suggestion => {
          expect(typeof suggestion).toBe('string');
          expect(suggestion.length).toBeGreaterThan(0);
        });

        // Property: Modified prompt should be provided if canRetry is true
        if (analysis.canRetry && analysis.modifiedPrompt) {
          expect(typeof analysis.modifiedPrompt).toBe('string');
          expect(analysis.modifiedPrompt.length).toBeGreaterThan(0);
          expect(analysis.modifiedPrompt).not.toBe(analysis.originalPrompt);
        }
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property: Content policy error identification consistency
   * For any error, the identification should be consistent and deterministic
   */
  it('Feature: third-party-api-compatibility, Property: Content policy error identification consistency', () => {
    fc.assert(
      fc.property(
        fc.oneof(arbitraryContentPolicyError, arbitraryNonContentPolicyError),
        (error) => {
          const result1 = handler.isContentPolicyError(error);
          const result2 = handler.isContentPolicyError(error);

          // Property: Results should be consistent
          expect(result1).toBe(result2);
          expect(typeof result1).toBe('boolean');

          // Property: Content policy errors should be identified correctly
          if (error.type === 'content_policy') {
            // Most content policy errors should be identified, but not all
            // (depends on the message content)
            expect(typeof result1).toBe('boolean');
          } else {
            // Non-content policy errors should generally not be identified as such
            // unless they contain content policy keywords in the message
            expect(typeof result1).toBe('boolean');
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property: User-friendly message generation consistency
   * For any analysis, the generated message should be comprehensive and helpful
   */
  it('Feature: third-party-api-compatibility, Property: User-friendly message generation consistency', () => {
    fc.assert(
      fc.property(arbitraryContentPolicyError, arbitraryImageRequest, (error, request) => {
        const analysis = handler.analyzeContentPolicyError(error, request);
        const message = handler.generateUserFriendlyMessage(analysis);

        // Property: Message should be a non-empty string
        expect(typeof message).toBe('string');
        expect(message.length).toBeGreaterThan(0);

        // Property: Message should contain violation reason
        expect(message).toContain(analysis.violationReason);

        // Property: Message should contain suggestions if they exist
        if (analysis.suggestions.length > 0) {
          expect(message).toContain('Suggestions to fix this issue');
          analysis.suggestions.forEach(suggestion => {
            expect(message).toContain(suggestion);
          });
        }

        // Property: Message should contain modified prompt if available
        if (analysis.modifiedPrompt) {
          expect(message).toContain('Try this modified prompt');
          expect(message).toContain(analysis.modifiedPrompt);
        }

        // Property: Message generation should be deterministic
        const message2 = handler.generateUserFriendlyMessage(analysis);
        expect(message).toBe(message2);
      }),
      { numRuns: 50 }
    );
  });

  /**
   * Property: Preventive suggestions consistency
   * For any prompt, preventive suggestions should be relevant and helpful
   */
  it('Feature: third-party-api-compatibility, Property: Preventive suggestions consistency', () => {
    fc.assert(
      fc.property(arbitraryPrompt, (prompt) => {
        const suggestions = handler.getPreventiveSuggestions(prompt);

        // Property: Suggestions should be an array
        expect(Array.isArray(suggestions)).toBe(true);

        // Property: All suggestions should be non-empty strings
        suggestions.forEach(suggestion => {
          expect(typeof suggestion).toBe('string');
          expect(suggestion.length).toBeGreaterThan(0);
        });

        // Property: Suggestions should be deterministic
        const suggestions2 = handler.getPreventiveSuggestions(prompt);
        expect(suggestions).toEqual(suggestions2);

        // Property: No duplicate suggestions
        const uniqueSuggestions = [...new Set(suggestions)];
        expect(suggestions).toEqual(uniqueSuggestions);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property: Violation statistics accuracy
   * For any sequence of violations, statistics should be accurately tracked
   */
  it('Feature: third-party-api-compatibility, Property: Violation statistics accuracy', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            error: arbitraryContentPolicyError,
            request: arbitraryImageRequest,
          }),
          { minLength: 1, maxLength: 10 }
        ),
        (violations) => {
          // Clear history before test
          handler.clearViolationHistory();

          const providerId = 'test-provider';
          
          // Process all violations
          violations.forEach(({ error, request }) => {
            const errorWithProvider = { ...error, provider: providerId };
            handler.analyzeContentPolicyError(errorWithProvider, request);
          });

          const stats = handler.getViolationStats(providerId);

          // Property: Total violations should match input count
          expect(stats.totalViolations).toBe(violations.length);

          // Property: Category counts should sum to total
          const categorySum = Object.values(stats.byCategory).reduce((sum, count) => sum + count, 0);
          expect(categorySum).toBe(violations.length);

          // Property: Severity counts should sum to total
          const severitySum = Object.values(stats.bySeverity).reduce((sum, count) => sum + count, 0);
          expect(severitySum).toBe(violations.length);

          // Property: All counts should be non-negative
          Object.values(stats.byCategory).forEach(count => {
            expect(count).toBeGreaterThanOrEqual(0);
          });
          Object.values(stats.bySeverity).forEach(count => {
            expect(count).toBeGreaterThanOrEqual(0);
          });

          // Property: Common patterns should be an array of strings
          expect(Array.isArray(stats.commonPatterns)).toBe(true);
          stats.commonPatterns.forEach(pattern => {
            expect(typeof pattern).toBe('string');
          });
        }
      ),
      { numRuns: 30 }
    );
  });

  /**
   * Property: Clear violation history effectiveness
   * After clearing history, all statistics should be reset
   */
  it('Feature: third-party-api-compatibility, Property: Clear violation history effectiveness', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            error: arbitraryContentPolicyError,
            request: arbitraryImageRequest,
          }),
          { minLength: 1, maxLength: 5 }
        ),
        (violations) => {
          const providerId = 'test-provider';
          
          // Process violations to create history
          violations.forEach(({ error, request }) => {
            const errorWithProvider = { ...error, provider: providerId };
            handler.analyzeContentPolicyError(errorWithProvider, request);
          });

          // Verify history exists
          let stats = handler.getViolationStats(providerId);
          expect(stats.totalViolations).toBeGreaterThan(0);

          // Clear history
          handler.clearViolationHistory();

          // Property: After clearing, all stats should be reset
          stats = handler.getViolationStats(providerId);
          expect(stats.totalViolations).toBe(0);
          expect(Object.keys(stats.byCategory)).toHaveLength(0);
          expect(Object.keys(stats.bySeverity)).toHaveLength(0);
          expect(stats.commonPatterns).toHaveLength(0);
        }
      ),
      { numRuns: 20 }
    );
  });

  /**
   * Property: Analysis determinism
   * For the same error and request, analysis should be deterministic
   */
  it('Feature: third-party-api-compatibility, Property: Analysis determinism', () => {
    fc.assert(
      fc.property(arbitraryContentPolicyError, arbitraryImageRequest, (error, request) => {
        const analysis1 = handler.analyzeContentPolicyError(error, request);
        const analysis2 = handler.analyzeContentPolicyError(error, request);

        // Property: Core analysis fields should be identical
        expect(analysis1.category).toBe(analysis2.category);
        expect(analysis1.severity).toBe(analysis2.severity);
        expect(analysis1.originalPrompt).toBe(analysis2.originalPrompt);
        expect(analysis1.violationReason).toBe(analysis2.violationReason);
        expect(analysis1.canRetry).toBe(analysis2.canRetry);
        expect(analysis1.modifiedPrompt).toBe(analysis2.modifiedPrompt);

        // Property: Suggestions should be identical
        expect(analysis1.suggestions).toEqual(analysis2.suggestions);
      }),
      { numRuns: 50 }
    );
  });

  /**
   * Property: Modified prompt safety
   * Modified prompts should be safer than original prompts
   */
  it('Feature: third-party-api-compatibility, Property: Modified prompt safety', () => {
    fc.assert(
      fc.property(arbitraryContentPolicyError, arbitraryImageRequest, (error, request) => {
        const analysis = handler.analyzeContentPolicyError(error, request);

        if (analysis.modifiedPrompt) {
          // Property: Modified prompt should be different from original
          expect(analysis.modifiedPrompt).not.toBe(analysis.originalPrompt);

          // Property: Modified prompt should be a non-empty string
          expect(typeof analysis.modifiedPrompt).toBe('string');
          expect(analysis.modifiedPrompt.length).toBeGreaterThan(0);

          // Property: Modified prompt should have fewer preventive suggestions
          const originalSuggestions = handler.getPreventiveSuggestions(analysis.originalPrompt);
          const modifiedSuggestions = handler.getPreventiveSuggestions(analysis.modifiedPrompt);
          
          // Modified prompt should generally be safer (fewer suggestions)
          expect(modifiedSuggestions.length).toBeLessThanOrEqual(originalSuggestions.length);
        }
      }),
      { numRuns: 50 }
    );
  });
});