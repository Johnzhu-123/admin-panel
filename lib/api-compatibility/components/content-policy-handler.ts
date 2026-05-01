import {
  APIError,
  ImageGenerationRequest,
  ErrorInfo,
} from '../types';

/**
 * Content policy error patterns and their handling strategies
 */
interface ContentPolicyPattern {
  pattern: RegExp;
  category: ContentPolicyCategory;
  severity: 'low' | 'medium' | 'high';
  suggestion: string;
}

/**
 * Categories of content policy violations
 */
export enum ContentPolicyCategory {
  INAPPROPRIATE_CONTENT = 'inappropriate_content',
  VIOLENCE = 'violence',
  ADULT_CONTENT = 'adult_content',
  HATE_SPEECH = 'hate_speech',
  ILLEGAL_ACTIVITY = 'illegal_activity',
  COPYRIGHT_VIOLATION = 'copyright_violation',
  PERSONAL_INFORMATION = 'personal_information',
  SPAM = 'spam',
  UNKNOWN = 'unknown',
}

/**
 * Content policy error analysis result
 */
export interface ContentPolicyAnalysis {
  category: ContentPolicyCategory;
  severity: 'low' | 'medium' | 'high';
  originalPrompt: string;
  violationReason: string;
  suggestions: string[];
  modifiedPrompt?: string;
  canRetry: boolean;
}

/**
 * Content policy error handler
 * Identifies, categorizes, and provides suggestions for content policy violations
 */
export class ContentPolicyHandler {
  private policyPatterns: ContentPolicyPattern[] = [];
  private violationHistory: Map<string, ContentPolicyAnalysis[]> = new Map();

  constructor() {
    this.initializePolicyPatterns();
  }

  /**
   * Analyze a content policy error and provide suggestions
   */
  analyzeContentPolicyError(
    error: APIError,
    request: ImageGenerationRequest
  ): ContentPolicyAnalysis {
    const errorMessage = error.message.toLowerCase();
    const prompt = request.prompt.toLowerCase();

    // Find matching policy pattern
    const matchingPattern = this.findMatchingPattern(errorMessage, prompt);
    
    const analysis: ContentPolicyAnalysis = {
      category: matchingPattern?.category || ContentPolicyCategory.UNKNOWN,
      severity: matchingPattern?.severity || 'medium',
      originalPrompt: request.prompt,
      violationReason: this.extractViolationReason(error.message),
      suggestions: this.generateSuggestions(matchingPattern, request.prompt),
      canRetry: this.canRetryWithModifications(matchingPattern),
    };

    // Generate modified prompt if possible
    if (analysis.canRetry && matchingPattern) {
      analysis.modifiedPrompt = this.generateModifiedPrompt(request.prompt, matchingPattern);
    }

    // Record violation for pattern analysis
    this.recordViolation(error.provider, analysis);

    return analysis;
  }

  /**
   * Generate user-friendly error message
   */
  generateUserFriendlyMessage(analysis: ContentPolicyAnalysis): string {
    const baseMessage = `Content policy violation detected: ${analysis.violationReason}`;
    
    let message = baseMessage;
    
    if (analysis.suggestions.length > 0) {
      message += '\n\nSuggestions to fix this issue:';
      analysis.suggestions.forEach((suggestion, index) => {
        message += `\n${index + 1}. ${suggestion}`;
      });
    }

    if (analysis.modifiedPrompt) {
      message += `\n\nTry this modified prompt: "${analysis.modifiedPrompt}"`;
    }

    return message;
  }

  /**
   * Check if an error is a content policy violation
   */
  isContentPolicyError(error: APIError): boolean {
    const errorMessage = error.message.toLowerCase();
    const contentPolicyKeywords = [
      'content policy',
      'policy violation',
      'inappropriate content',
      'content filter',
      'safety filter',
      'content blocked',
      'violates our usage policies',
      'against our content policy',
      'content guidelines',
      'safety guidelines',
      'safety system',
      'rejected as a result of our safety',
    ];

    return contentPolicyKeywords.some(keyword => errorMessage.includes(keyword));
  }

  /**
   * Get violation statistics for a provider
   */
  getViolationStats(providerId: string): {
    totalViolations: number;
    byCategory: Record<ContentPolicyCategory, number>;
    bySeverity: Record<string, number>;
    commonPatterns: string[];
  } {
    const violations = this.violationHistory.get(providerId) || [];
    
    const byCategory: Record<ContentPolicyCategory, number> = {} as any;
    const bySeverity: Record<string, number> = {};
    const patterns: string[] = [];

    violations.forEach(violation => {
      byCategory[violation.category] = (byCategory[violation.category] || 0) + 1;
      bySeverity[violation.severity] = (bySeverity[violation.severity] || 0) + 1;
      patterns.push(violation.originalPrompt);
    });

    // Find common patterns (simplified)
    const commonPatterns = this.findCommonPatterns(patterns);

    return {
      totalViolations: violations.length,
      byCategory,
      bySeverity,
      commonPatterns,
    };
  }

  /**
   * Clear violation history
   */
  clearViolationHistory(): void {
    this.violationHistory.clear();
  }

  /**
   * Get content policy suggestions for a prompt before sending
   */
  getPreventiveSuggestions(prompt: string): string[] {
    const suggestions: string[] = [];
    const lowerPrompt = prompt.toLowerCase();

    // Check for potentially problematic content
    if (this.containsViolence(lowerPrompt)) {
      suggestions.push('Consider removing violent or aggressive language');
      suggestions.push('Focus on peaceful or constructive themes');
    }

    if (this.containsAdultContent(lowerPrompt)) {
      suggestions.push('Remove any adult or suggestive content');
      suggestions.push('Use family-friendly descriptions');
    }

    if (this.containsCopyrightedContent(lowerPrompt)) {
      suggestions.push('Avoid referencing specific copyrighted characters or brands');
      suggestions.push('Use generic descriptions instead of brand names');
    }

    if (this.containsPersonalInfo(lowerPrompt)) {
      suggestions.push('Remove any personal information like names or addresses');
      suggestions.push('Use generic terms instead of specific identifiers');
    }

    return suggestions;
  }

  private initializePolicyPatterns(): void {
    this.policyPatterns = [
      // Violence patterns
      {
        pattern: /\b(violence|violent|blood|gore|weapon|gun|knife|kill|murder|death|fight|attack|war|battle)\b/i,
        category: ContentPolicyCategory.VIOLENCE,
        severity: 'high',
        suggestion: 'Remove violent content and focus on peaceful themes',
      },
      
      // Adult content patterns
      {
        pattern: /\b(nude|naked|sex|sexual|adult|erotic|porn|explicit|intimate)\b/i,
        category: ContentPolicyCategory.ADULT_CONTENT,
        severity: 'high',
        suggestion: 'Remove adult content and use family-friendly descriptions',
      },
      
      // Hate speech patterns
      {
        pattern: /\b(hate|racist|discrimination|offensive|slur|bigot)\b/i,
        category: ContentPolicyCategory.HATE_SPEECH,
        severity: 'high',
        suggestion: 'Remove hateful language and use respectful terms',
      },
      
      // Copyright patterns
      {
        pattern: /\b(disney|marvel|pokemon|nintendo|sony|microsoft|apple|google|facebook|twitter|batman|superman|spiderman|dc|comics|warner)\b/i,
        category: ContentPolicyCategory.COPYRIGHT_VIOLATION,
        severity: 'medium',
        suggestion: 'Avoid copyrighted characters and brands, use generic alternatives',
      },
      
      // Personal information patterns
      {
        pattern: /\b(\d{3}-\d{3}-\d{4}|\d{3}\.\d{3}\.\d{4}|@\w+\.\w+|www\.\w+\.\w+)\b/i,
        category: ContentPolicyCategory.PERSONAL_INFORMATION,
        severity: 'medium',
        suggestion: 'Remove personal information like phone numbers, emails, or websites',
      },
      
      // Inappropriate content patterns
      {
        pattern: /\b(inappropriate|offensive|disturbing|shocking|controversial)\b/i,
        category: ContentPolicyCategory.INAPPROPRIATE_CONTENT,
        severity: 'medium',
        suggestion: 'Use more appropriate and neutral language',
      },
    ];
  }

  private findMatchingPattern(errorMessage: string, prompt: string): ContentPolicyPattern | null {
    // First check error message for specific patterns
    for (const pattern of this.policyPatterns) {
      if (pattern.pattern.test(errorMessage)) {
        return pattern;
      }
    }

    // Then check the original prompt
    for (const pattern of this.policyPatterns) {
      if (pattern.pattern.test(prompt)) {
        return pattern;
      }
    }

    return null;
  }

  private extractViolationReason(errorMessage: string): string {
    // Extract the specific reason from the error message
    const reasonPatterns = [
      /policy violation[:\s]*([^.]+)/i,
      /content policy[:\s]*([^.]+)/i,
      /violates[:\s]*([^.]+)/i,
      /blocked[:\s]*([^.]+)/i,
    ];

    for (const pattern of reasonPatterns) {
      const match = errorMessage.match(pattern);
      if (match && match[1]) {
        return match[1].trim();
      }
    }

    return 'Content does not comply with usage policies';
  }

  private generateSuggestions(pattern: ContentPolicyPattern | null, prompt: string): string[] {
    const suggestions: string[] = [];

    if (pattern) {
      suggestions.push(pattern.suggestion);
    }

    // Add general suggestions
    suggestions.push('Try using more descriptive but neutral language');
    suggestions.push('Focus on visual elements rather than controversial topics');
    suggestions.push('Consider breaking down complex requests into simpler parts');

    // Add specific suggestions based on prompt analysis
    const preventiveSuggestions = this.getPreventiveSuggestions(prompt);
    suggestions.push(...preventiveSuggestions);

    // Remove duplicates
    return [...new Set(suggestions)];
  }

  private generateModifiedPrompt(originalPrompt: string, pattern: ContentPolicyPattern): string {
    let modifiedPrompt = originalPrompt;

    // Apply pattern-specific modifications
    switch (pattern.category) {
      case ContentPolicyCategory.VIOLENCE:
        modifiedPrompt = modifiedPrompt.replace(/\b(violence|violent|blood|gore|weapon|gun|knife|kill|murder|death|fight|attack|war|battle)\b/gi, 'peaceful');
        break;
      
      case ContentPolicyCategory.ADULT_CONTENT:
        modifiedPrompt = modifiedPrompt.replace(/\b(nude|naked|sex|sexual|adult|erotic|porn|explicit|intimate)\b/gi, 'artistic');
        break;
      
      case ContentPolicyCategory.HATE_SPEECH:
        modifiedPrompt = modifiedPrompt.replace(/\b(hate|racist|discrimination|offensive|slur|bigot)\b/gi, 'respectful');
        break;
      
      case ContentPolicyCategory.COPYRIGHT_VIOLATION:
        modifiedPrompt = modifiedPrompt.replace(/\b(disney|marvel|pokemon|nintendo|sony|microsoft|apple|google|facebook|twitter|batman|superman|spiderman|dc|comics|warner)\b/gi, 'fantasy character');
        break;
    }

    // Add safe prefixes if needed
    if (modifiedPrompt === originalPrompt) {
      modifiedPrompt = `A safe and appropriate image of ${originalPrompt}`;
    }

    return modifiedPrompt;
  }

  private canRetryWithModifications(pattern: ContentPolicyPattern | null): boolean {
    if (!pattern) return false;
    
    // High severity violations are harder to fix automatically
    return pattern.severity !== 'high';
  }

  private recordViolation(providerId: string, analysis: ContentPolicyAnalysis): void {
    if (!this.violationHistory.has(providerId)) {
      this.violationHistory.set(providerId, []);
    }
    
    const violations = this.violationHistory.get(providerId)!;
    violations.push(analysis);
    
    // Keep only the last 100 violations per provider
    if (violations.length > 100) {
      violations.splice(0, violations.length - 100);
    }
  }

  private findCommonPatterns(prompts: string[]): string[] {
    // Simplified pattern detection - in a real implementation,
    // this would use more sophisticated text analysis
    const wordCounts: Record<string, number> = {};
    
    prompts.forEach(prompt => {
      const words = prompt.toLowerCase().split(/\s+/);
      words.forEach(word => {
        if (word.length > 3) { // Only count meaningful words
          wordCounts[word] = (wordCounts[word] || 0) + 1;
        }
      });
    });

    // Return words that appear in at least 20% of prompts
    const threshold = Math.max(1, Math.floor(prompts.length * 0.2));
    return Object.entries(wordCounts)
      .filter(([_, count]) => count >= threshold)
      .sort(([_, a], [__, b]) => b - a)
      .slice(0, 10)
      .map(([word, _]) => word);
  }

  private containsViolence(prompt: string): boolean {
    return /\b(violence|violent|blood|gore|weapon|gun|knife|kill|murder|death|fight|attack|war|battle)\b/i.test(prompt);
  }

  private containsAdultContent(prompt: string): boolean {
    return /\b(nude|naked|sex|sexual|adult|erotic|porn|explicit|intimate)\b/i.test(prompt);
  }

  private containsCopyrightedContent(prompt: string): boolean {
    return /\b(disney|marvel|pokemon|nintendo|sony|microsoft|apple|google|facebook|twitter|batman|superman|spiderman|dc|comics|warner)\b/i.test(prompt);
  }

  private containsPersonalInfo(prompt: string): boolean {
    return /\b(\d{3}-\d{3}-\d{4}|\d{3}\.\d{3}\.\d{4}|@\w+\.\w+|www\.\w+\.\w+)\b/i.test(prompt);
  }
}