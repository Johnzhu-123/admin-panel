import { ContentPolicyHandler, ContentPolicyCategory } from '../content-policy-handler';
import { APIError, ImageGenerationRequest } from '../../types';

describe('ContentPolicyHandler', () => {
  let handler: ContentPolicyHandler;

  beforeEach(() => {
    handler = new ContentPolicyHandler();
  });

  describe('isContentPolicyError', () => {
    it('should identify content policy errors correctly', () => {
      const contentPolicyError: APIError = {
        type: 'content_policy',
        code: 'content_policy_violation',
        message: 'Your request was rejected as a result of our safety system. Your prompt may contain text that is not allowed by our safety system.',
        provider: 'test-provider',
        timestamp: new Date(),
        request: { prompt: 'test prompt' },
      };

      expect(handler.isContentPolicyError(contentPolicyError)).toBe(true);
    });

    it('should not identify non-content-policy errors', () => {
      const networkError: APIError = {
        type: 'network_error',
        code: 'connection_timeout',
        message: 'Connection timed out',
        provider: 'test-provider',
        timestamp: new Date(),
        request: { prompt: 'test prompt' },
      };

      expect(handler.isContentPolicyError(networkError)).toBe(false);
    });

    it('should identify various content policy error messages', () => {
      const errorMessages = [
        'Content policy violation detected',
        'This request violates our usage policies',
        'Content blocked by safety filter',
        'Against our content policy',
        'Inappropriate content detected',
      ];

      errorMessages.forEach(message => {
        const error: APIError = {
          type: 'content_policy',
          code: 'policy_violation',
          message,
          provider: 'test-provider',
          timestamp: new Date(),
          request: { prompt: 'test prompt' },
        };

        expect(handler.isContentPolicyError(error)).toBe(true);
      });
    });
  });

  describe('analyzeContentPolicyError', () => {
    it('should analyze violence-related content policy errors', () => {
      const request: ImageGenerationRequest = {
        prompt: 'A violent battle scene with weapons and blood',
      };

      const error: APIError = {
        type: 'content_policy',
        code: 'violence_detected',
        message: 'Content policy violation: violent content detected',
        provider: 'test-provider',
        timestamp: new Date(),
        request,
      };

      const analysis = handler.analyzeContentPolicyError(error, request);

      expect(analysis.category).toBe(ContentPolicyCategory.VIOLENCE);
      expect(analysis.severity).toBe('high');
      expect(analysis.originalPrompt).toBe(request.prompt);
      expect(analysis.suggestions).toContain('Remove violent content and focus on peaceful themes');
      expect(analysis.canRetry).toBe(false); // High severity
    });

    it('should analyze copyright-related content policy errors', () => {
      const request: ImageGenerationRequest = {
        prompt: 'Mickey Mouse from Disney in a park',
      };

      const error: APIError = {
        type: 'content_policy',
        code: 'copyright_violation',
        message: 'Content policy violation: copyrighted content detected',
        provider: 'test-provider',
        timestamp: new Date(),
        request,
      };

      const analysis = handler.analyzeContentPolicyError(error, request);

      expect(analysis.category).toBe(ContentPolicyCategory.COPYRIGHT_VIOLATION);
      expect(analysis.severity).toBe('medium');
      expect(analysis.canRetry).toBe(true); // Medium severity allows retry
      expect(analysis.modifiedPrompt).toBeDefined();
      expect(analysis.modifiedPrompt).toContain('fantasy character');
    });

    it('should handle unknown content policy errors', () => {
      const request: ImageGenerationRequest = {
        prompt: 'A normal landscape scene',
      };

      const error: APIError = {
        type: 'content_policy',
        code: 'unknown_violation',
        message: 'Content policy violation: unknown reason',
        provider: 'test-provider',
        timestamp: new Date(),
        request,
      };

      const analysis = handler.analyzeContentPolicyError(error, request);

      expect(analysis.category).toBe(ContentPolicyCategory.UNKNOWN);
      expect(analysis.severity).toBe('medium');
      expect(analysis.suggestions.length).toBeGreaterThan(0);
    });
  });

  describe('generateUserFriendlyMessage', () => {
    it('should generate comprehensive user-friendly messages', () => {
      const analysis = {
        category: ContentPolicyCategory.VIOLENCE,
        severity: 'high' as const,
        originalPrompt: 'violent scene',
        violationReason: 'violent content detected',
        suggestions: ['Remove violent content', 'Use peaceful themes'],
        modifiedPrompt: 'peaceful scene',
        canRetry: true,
      };

      const message = handler.generateUserFriendlyMessage(analysis);

      expect(message).toContain('Content policy violation detected');
      expect(message).toContain('violent content detected');
      expect(message).toContain('Suggestions to fix this issue');
      expect(message).toContain('Remove violent content');
      expect(message).toContain('Use peaceful themes');
      expect(message).toContain('Try this modified prompt: "peaceful scene"');
    });

    it('should handle analysis without modified prompt', () => {
      const analysis = {
        category: ContentPolicyCategory.UNKNOWN,
        severity: 'medium' as const,
        originalPrompt: 'test prompt',
        violationReason: 'unknown violation',
        suggestions: ['Try different wording'],
        canRetry: false,
      };

      const message = handler.generateUserFriendlyMessage(analysis);

      expect(message).toContain('Content policy violation detected');
      expect(message).toContain('unknown violation');
      expect(message).toContain('Try different wording');
      expect(message).not.toContain('Try this modified prompt');
    });
  });

  describe('getPreventiveSuggestions', () => {
    it('should provide suggestions for potentially problematic content', () => {
      const violentPrompt = 'A battle scene with weapons and fighting';
      const suggestions = handler.getPreventiveSuggestions(violentPrompt);

      expect(suggestions).toContain('Consider removing violent or aggressive language');
      expect(suggestions).toContain('Focus on peaceful or constructive themes');
    });

    it('should provide suggestions for adult content', () => {
      const adultPrompt = 'A nude figure in artistic pose';
      const suggestions = handler.getPreventiveSuggestions(adultPrompt);

      expect(suggestions).toContain('Remove any adult or suggestive content');
      expect(suggestions).toContain('Use family-friendly descriptions');
    });

    it('should provide suggestions for copyrighted content', () => {
      const copyrightPrompt = 'Batman from DC Comics';
      const suggestions = handler.getPreventiveSuggestions(copyrightPrompt);

      expect(suggestions).toContain('Avoid referencing specific copyrighted characters or brands');
      expect(suggestions).toContain('Use generic descriptions instead of brand names');
    });

    it('should return empty array for safe content', () => {
      const safePrompt = 'A beautiful landscape with mountains and trees';
      const suggestions = handler.getPreventiveSuggestions(safePrompt);

      expect(suggestions).toHaveLength(0);
    });
  });

  describe('getViolationStats', () => {
    it('should track violation statistics correctly', () => {
      const request1: ImageGenerationRequest = { prompt: 'violent scene' };
      const request2: ImageGenerationRequest = { prompt: 'another violent scene' };
      const request3: ImageGenerationRequest = { prompt: 'disney character' };

      const error1: APIError = {
        type: 'content_policy',
        code: 'violence',
        message: 'violent content',
        provider: 'test-provider',
        timestamp: new Date(),
        request: request1,
      };

      const error2: APIError = {
        type: 'content_policy',
        code: 'violence',
        message: 'violent content',
        provider: 'test-provider',
        timestamp: new Date(),
        request: request2,
      };

      const error3: APIError = {
        type: 'content_policy',
        code: 'copyright',
        message: 'copyright violation',
        provider: 'test-provider',
        timestamp: new Date(),
        request: request3,
      };

      // Analyze errors to record violations
      handler.analyzeContentPolicyError(error1, request1);
      handler.analyzeContentPolicyError(error2, request2);
      handler.analyzeContentPolicyError(error3, request3);

      const stats = handler.getViolationStats('test-provider');

      expect(stats.totalViolations).toBe(3);
      expect(stats.byCategory[ContentPolicyCategory.VIOLENCE]).toBe(2);
      expect(stats.byCategory[ContentPolicyCategory.COPYRIGHT_VIOLATION]).toBe(1);
      expect(stats.bySeverity.high).toBe(2); // Violence is high severity
      expect(stats.bySeverity.medium).toBe(1); // Copyright is medium severity
    });

    it('should return empty stats for unknown provider', () => {
      const stats = handler.getViolationStats('unknown-provider');

      expect(stats.totalViolations).toBe(0);
      expect(Object.keys(stats.byCategory)).toHaveLength(0);
      expect(Object.keys(stats.bySeverity)).toHaveLength(0);
      expect(stats.commonPatterns).toHaveLength(0);
    });
  });

  describe('clearViolationHistory', () => {
    it('should clear all violation history', () => {
      const request: ImageGenerationRequest = { prompt: 'violent scene' };
      const error: APIError = {
        type: 'content_policy',
        code: 'violence',
        message: 'violent content',
        provider: 'test-provider',
        timestamp: new Date(),
        request,
      };

      // Record a violation
      handler.analyzeContentPolicyError(error, request);

      // Verify violation was recorded
      let stats = handler.getViolationStats('test-provider');
      expect(stats.totalViolations).toBe(1);

      // Clear history
      handler.clearViolationHistory();

      // Verify history is cleared
      stats = handler.getViolationStats('test-provider');
      expect(stats.totalViolations).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('should handle empty prompts', () => {
      const request: ImageGenerationRequest = { prompt: '' };
      const error: APIError = {
        type: 'content_policy',
        code: 'empty_prompt',
        message: 'Empty prompt violation',
        provider: 'test-provider',
        timestamp: new Date(),
        request,
      };

      const analysis = handler.analyzeContentPolicyError(error, request);

      expect(analysis.originalPrompt).toBe('');
      expect(analysis.suggestions.length).toBeGreaterThan(0);
    });

    it('should handle very long prompts', () => {
      const longPrompt = 'A '.repeat(1000) + 'violent scene';
      const request: ImageGenerationRequest = { prompt: longPrompt };
      const error: APIError = {
        type: 'content_policy',
        code: 'violence',
        message: 'violent content',
        provider: 'test-provider',
        timestamp: new Date(),
        request,
      };

      const analysis = handler.analyzeContentPolicyError(error, request);

      expect(analysis.category).toBe(ContentPolicyCategory.VIOLENCE);
      expect(analysis.originalPrompt).toBe(longPrompt);
    });

    it('should handle prompts with mixed content types', () => {
      const mixedPrompt = 'A Disney character in a violent battle with adult themes';
      const request: ImageGenerationRequest = { prompt: mixedPrompt };
      const error: APIError = {
        type: 'content_policy',
        code: 'multiple_violations',
        message: 'multiple policy violations',
        provider: 'test-provider',
        timestamp: new Date(),
        request,
      };

      const analysis = handler.analyzeContentPolicyError(error, request);

      // Should detect at least one category
      expect(analysis.category).not.toBe(ContentPolicyCategory.UNKNOWN);
      expect(analysis.suggestions.length).toBeGreaterThan(0);
    });
  });
});