import {
  FallbackStrategy,
  FallbackHandler,
} from '../interfaces';
import {
  APIError,
  ImageGenerationRequest,
  FallbackResult,
  FallbackOption,
  APIProvider,
  ImageGenerationResponse,
  ErrorType,
} from '../types';

/**
 * Fallback strategy implementation for handling API failures
 * Provides intelligent fallback mechanisms based on error types
 */
export class FallbackStrategyImpl implements FallbackStrategy {
  private fallbackHandlers: Map<string, FallbackHandler> = new Map();
  private fallbackStats: Map<string, { used: number; success: number }> = new Map();

  constructor(initializeDefaults: boolean = true) {
    if (initializeDefaults) {
      this.initializeDefaultHandlers();
    }
  }

  /**
   * Execute fallback strategy for a failed request
   */
  async executeFallback(
    originalRequest: ImageGenerationRequest,
    error: APIError
  ): Promise<FallbackResult> {
    // 🔧 FIX (2026-06-11 BUG-A20/C13): 识别"安全提示词重试已成功"的 recovered 错误
    // （code=content_policy_resolved 且 response 里带成功的 images）。这类对象本质是
    // 成功结果，直接作为成功 FallbackResult 返回，不再丢图走降级链。
    // （manager.handleAPIError 已改为返回 { recovered }，此处是对历史路径/外部
    // 构造的同类错误的兜底。）
    const recoveredResponse = this.extractRecoveredResponse(error);
    if (recoveredResponse) {
      return {
        success: true,
        result: recoveredResponse,
        fallbackUsed: 'content_policy_recovered',
        originalError: error,
      };
    }

    const fallbackOptions = this.getFallbackOptionsForError(error);
    
    // Try fallback options in priority order
    for (const option of fallbackOptions) {
      const handler = this.fallbackHandlers.get(option.id);
      if (!handler) continue;

      // Record usage before attempting
      this.recordFallbackUsage(option.id);
      
      try {
        const result = await handler.execute(originalRequest, error);
        
        if (result.success) {
          this.recordFallbackSuccess(option.id);
          return {
            ...result,
            fallbackUsed: option.id,
            originalError: error,
          };
        }
        // If not successful, continue to next option without recording success
      } catch (fallbackError) {
        // Continue to next fallback option
        console.warn(`Fallback ${option.id} failed:`, fallbackError);
      }
    }

    // All fallback options failed
    return {
      success: false,
      fallbackUsed: 'none',
      originalError: error,
    };
  }

  /**
   * Register a fallback handler for a specific error type
   */
  registerFallbackHandler(errorType: string, handler: FallbackHandler): void {
    this.fallbackHandlers.set(errorType, handler);
    
    // Initialize stats for this handler
    if (!this.fallbackStats.has(errorType)) {
      this.fallbackStats.set(errorType, { used: 0, success: 0 });
    }
  }

  /**
   * Get available fallback options for a provider
   */
  getFallbackOptions(provider: APIProvider): FallbackOption[] {
    return [
      {
        id: 'path_retry',
        name: 'Path Retry',
        description: 'Retry with alternative API paths',
        priority: 1,
        canHandle: (error) => error.type === 'path_error',
      },
      {
        id: 'format_fallback',
        name: 'Format Fallback',
        description: 'Try alternative response formats',
        priority: 2,
        canHandle: (error) => error.type === 'format_error',
      },
      {
        id: 'auth_retry',
        name: 'Authentication Retry',
        description: 'Retry with alternative authentication methods',
        priority: 3,
        canHandle: (error) => error.type === 'auth_error',
      },
      {
        id: 'chat_fallback',
        name: 'Chat API Fallback',
        description: 'Use chat API to generate image descriptions',
        priority: 4,
        canHandle: (error) => 
          error.type === 'path_error' || 
          error.type === 'format_error' ||
          error.type === 'content_policy',
      },
      {
        id: 'network_retry',
        name: 'Network Retry',
        description: 'Retry with network optimizations',
        priority: 5,
        canHandle: (error) => error.type === 'network_error',
      },
      {
        id: 'rate_limit_backoff',
        name: 'Rate Limit Backoff',
        description: 'Wait and retry with exponential backoff',
        priority: 6,
        canHandle: (error) => error.type === 'rate_limit',
      },
    ];
  }

  /**
   * Get fallback statistics
   */
  getFallbackStats(): Record<string, { used: number; success: number; successRate: number }> {
    const stats: Record<string, { used: number; success: number; successRate: number }> = {};
    
    for (const [handlerId, stat] of this.fallbackStats.entries()) {
      stats[handlerId] = {
        used: stat.used,
        success: stat.success,
        successRate: stat.used > 0 ? stat.success / stat.used : 0,
      };
    }
    
    return stats;
  }

  /**
   * Clear fallback statistics
   */
  clearStats(): void {
    this.fallbackStats.clear();
  }

  /**
   * 🔧 FIX (2026-06-11 BUG-A20/C13): 从 recovered 形态的错误对象中提取成功响应。
   */
  private extractRecoveredResponse(error: APIError): ImageGenerationResponse | null {
    if (!error || error.code !== 'content_policy_resolved') return null;
    const candidate = error.response as ImageGenerationResponse | undefined;
    if (
      candidate &&
      typeof candidate === 'object' &&
      Array.isArray(candidate.images) &&
      candidate.images.length > 0
    ) {
      return candidate;
    }
    return null;
  }

  private initializeDefaultHandlers(): void {
    // Path retry handler
    this.registerFallbackHandler('path_retry', new PathRetryHandler());
    
    // Format fallback handler
    this.registerFallbackHandler('format_fallback', new FormatFallbackHandler());
    
    // Authentication retry handler
    this.registerFallbackHandler('auth_retry', new AuthRetryHandler());
    
    // Chat API fallback handler
    this.registerFallbackHandler('chat_fallback', new ChatFallbackHandler());
    
    // Network retry handler
    this.registerFallbackHandler('network_retry', new NetworkRetryHandler());
    
    // Rate limit backoff handler
    this.registerFallbackHandler('rate_limit_backoff', new RateLimitBackoffHandler());
  }

  private getFallbackOptionsForError(error: APIError): FallbackOption[] {
    // Get all registered handlers
    const registeredHandlers = Array.from(this.fallbackHandlers.keys());
    
    // Create options from registered handlers
    const options: FallbackOption[] = [];
    
    for (const handlerId of registeredHandlers) {
      const handler = this.fallbackHandlers.get(handlerId)!;
      if (handler.canHandle(error)) {
        options.push({
          id: handlerId,
          name: handlerId,
          description: `Fallback handler: ${handlerId}`,
          priority: 1, // All custom handlers get priority 1
          canHandle: handler.canHandle,
        });
      }
    }
    
    // If no registered handlers can handle the error, try default options
    if (options.length === 0) {
      const allOptions = this.getFallbackOptions({} as APIProvider);
      return allOptions
        .filter(option => option.canHandle(error))
        .sort((a, b) => a.priority - b.priority);
    }
    
    return options.sort((a, b) => a.priority - b.priority);
  }

  private recordFallbackUsage(handlerId: string): void {
    if (!this.fallbackStats.has(handlerId)) {
      this.fallbackStats.set(handlerId, { used: 0, success: 0 });
    }
    const stats = this.fallbackStats.get(handlerId)!;
    stats.used++;
  }

  private recordFallbackSuccess(handlerId: string): void {
    if (!this.fallbackStats.has(handlerId)) {
      this.fallbackStats.set(handlerId, { used: 0, success: 0 });
    }
    const stats = this.fallbackStats.get(handlerId)!;
    stats.success++;
  }
}

/**
 * Path retry fallback handler
 * Tries alternative API paths when the original path fails
 */
class PathRetryHandler implements FallbackHandler {
  canHandle(error: APIError): boolean {
    return error.type === 'path_error';
  }

  async execute(
    request: ImageGenerationRequest,
    error: APIError
  ): Promise<FallbackResult> {
    // Alternative paths to try
    const alternativePaths = [
      '/v1/images/generations',
      '/images/generations',
      '/api/v1/images/generations',
      '/openai/v1/images/generations',
    ];

    // This is a simplified implementation
    // In a real scenario, we would make actual API calls with different paths
    return {
      success: false,
      fallbackUsed: 'path_retry',
      originalError: error,
    };
  }
}

/**
 * Format fallback handler
 * Tries alternative response formats when format errors occur
 */
class FormatFallbackHandler implements FallbackHandler {
  canHandle(error: APIError): boolean {
    return error.type === 'format_error';
  }

  async execute(
    request: ImageGenerationRequest,
    error: APIError
  ): Promise<FallbackResult> {
    // Try alternative formats
    const alternativeFormats = ['url', 'b64_json'];
    const currentFormat = request.response_format || 'url';
    
    // Switch to alternative format
    const newFormat = alternativeFormats.find(f => f !== currentFormat) || 'url';
    
    // This is a simplified implementation
    // In a real scenario, we would make actual API calls with different formats
    return {
      success: false,
      fallbackUsed: 'format_fallback',
      originalError: error,
    };
  }
}

/**
 * Authentication retry handler
 * Tries alternative authentication methods
 */
class AuthRetryHandler implements FallbackHandler {
  canHandle(error: APIError): boolean {
    return error.type === 'auth_error';
  }

  async execute(
    request: ImageGenerationRequest,
    error: APIError
  ): Promise<FallbackResult> {
    // This would try different authentication methods
    // Implementation depends on the specific authentication handler
    return {
      success: false,
      fallbackUsed: 'auth_retry',
      originalError: error,
    };
  }
}

/**
 * Chat API fallback handler
 * Uses chat API to generate image descriptions when image generation fails
 */
class ChatFallbackHandler implements FallbackHandler {
  canHandle(error: APIError): boolean {
    return error.type === 'path_error' || 
           error.type === 'format_error' ||
           error.type === 'content_policy';
  }

  async execute(
    request: ImageGenerationRequest,
    error: APIError
  ): Promise<FallbackResult> {
    // Generate a descriptive response using chat API
    const fallbackResponse: ImageGenerationResponse = {
      images: [{
        revised_prompt: `Unable to generate image for: "${request.prompt}". Reason: ${error.message}. Please try with a different prompt or check your API configuration.`,
      }],
      error: {
        message: `Image generation failed, provided description instead: ${error.message}`,
        type: 'fallback_used',
      },
    };

    return {
      success: true,
      result: fallbackResponse,
      fallbackUsed: 'chat_fallback',
      originalError: error,
    };
  }
}

/**
 * Network retry handler
 * Handles network-related failures with retry logic
 */
class NetworkRetryHandler implements FallbackHandler {
  canHandle(error: APIError): boolean {
    return error.type === 'network_error';
  }

  async execute(
    request: ImageGenerationRequest,
    error: APIError
  ): Promise<FallbackResult> {
    // Implement network retry with exponential backoff
    // This is a simplified implementation
    return {
      success: false,
      fallbackUsed: 'network_retry',
      originalError: error,
    };
  }
}

/**
 * Rate limit backoff handler
 * Handles rate limiting with exponential backoff
 */
class RateLimitBackoffHandler implements FallbackHandler {
  canHandle(error: APIError): boolean {
    return error.type === 'rate_limit';
  }

  async execute(
    request: ImageGenerationRequest,
    error: APIError
  ): Promise<FallbackResult> {
    // Extract retry-after header or use default backoff
    const retryAfter = this.extractRetryAfter(error);
    
    // Wait for the specified time
    await this.sleep(retryAfter);
    
    // This is a simplified implementation
    // In a real scenario, we would retry the original request
    return {
      success: false,
      fallbackUsed: 'rate_limit_backoff',
      originalError: error,
    };
  }

  private extractRetryAfter(error: APIError): number {
    // Try to extract retry-after from response headers
    if (error.response?.headers?.['retry-after']) {
      return parseInt(error.response.headers['retry-after']) * 1000;
    }
    
    // Default exponential backoff: 1s, 2s, 4s, 8s, etc.
    return Math.min(1000 * Math.pow(2, 3), 30000); // Max 30 seconds
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}