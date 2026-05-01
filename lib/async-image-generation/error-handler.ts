/**
 * Unified Error Handler for Async Image Generation
 * Provides centralized error handling, logging, and user-friendly error messages
 */

import { updateTaskStatus } from './task-manager';

/**
 * Error categories for classification
 */
export enum ErrorCategory {
  DATABASE = 'DATABASE',
  TIMEOUT = 'TIMEOUT',
  API = 'API',
  VALIDATION = 'VALIDATION',
  NETWORK = 'NETWORK',
  CONTENT_POLICY = 'CONTENT_POLICY',
  UNKNOWN = 'UNKNOWN',
}

/**
 * Error context for logging
 */
export interface ErrorContext {
  operation: string;
  taskId?: string;
  userId?: string;
  provider?: string;
  additionalInfo?: Record<string, any>;
}

/**
 * Error response structure
 */
export interface ErrorResponse {
  error: string;
  details?: string;
  category?: ErrorCategory;
}

/**
 * Categorize error based on error message and type
 * 
 * @param error - The error to categorize
 * @returns Error category
 */
export function categorizeError(error: Error): ErrorCategory {
  const message = error.message.toLowerCase();

  // Content policy errors (check first as they're most specific)
  if (
    message.includes('content policy') ||
    message.includes('safety') ||
    message.includes('inappropriate') ||
    message.includes('violated') ||
    message.includes('blocked')
  ) {
    return ErrorCategory.CONTENT_POLICY;
  }

  // Database errors (check early to catch database-specific timeouts)
  if (
    message.includes('postgres') ||
    message.includes('sql') ||
    (message.includes('database') && (message.includes('query') || message.includes('timeout') || message.includes('connection')))
  ) {
    return ErrorCategory.DATABASE;
  }

  // Timeout errors (check after database to avoid confusion)
  if (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('time limit')
  ) {
    return ErrorCategory.TIMEOUT;
  }

  // API errors (check before general "exceeded" keyword)
  if (
    message.includes('rate limit') ||
    message.includes('quota') ||
    message.includes('unauthorized') ||
    message.includes('forbidden') ||
    message.includes('invalid key') ||
    message.includes('authentication') ||
    (message.includes('api') && !message.includes('database'))
  ) {
    return ErrorCategory.API;
  }

  // Network errors
  if (
    message.includes('network') ||
    message.includes('fetch') ||
    message.includes('econnrefused') ||
    message.includes('enotfound') ||
    message.includes('etimedout') ||
    message.includes('socket')
  ) {
    return ErrorCategory.NETWORK;
  }

  // Validation errors
  if (
    message.includes('validation') ||
    message.includes('invalid') ||
    message.includes('required') ||
    message.includes('missing')
  ) {
    return ErrorCategory.VALIDATION;
  }

  // Check for "exceeded" last as it's generic
  if (message.includes('exceeded')) {
    return ErrorCategory.TIMEOUT;
  }

  return ErrorCategory.UNKNOWN;
}

/**
 * Map error to user-friendly message
 * 
 * @param error - The error to map
 * @param category - Error category
 * @returns User-friendly error message
 */
export function getUserFriendlyMessage(
  error: Error,
  category: ErrorCategory
): string {
  const message = error.message.toLowerCase();

  switch (category) {
    case ErrorCategory.DATABASE:
      return 'Database error occurred. Please try again later.';

    case ErrorCategory.TIMEOUT:
      return 'Request timeout. The operation took too long to complete.';

    case ErrorCategory.API:
      if (message.includes('rate limit')) {
        return 'API rate limit exceeded. Please try again later.';
      }
      if (message.includes('unauthorized') || message.includes('authentication')) {
        return 'API authentication failed. Please check your API key.';
      }
      if (message.includes('quota')) {
        return 'API quota exceeded. Please check your account limits.';
      }
      return 'API error occurred. Please check your configuration.';

    case ErrorCategory.NETWORK:
      return 'Network error occurred. Please check your connection and try again.';

    case ErrorCategory.CONTENT_POLICY:
      return 'Content policy violation. Please modify your prompt and try again.';

    case ErrorCategory.VALIDATION:
      return error.message; // Validation errors are already user-friendly

    case ErrorCategory.UNKNOWN:
    default:
      return 'An unexpected error occurred. Please try again.';
  }
}

/**
 * Log error with context
 * 
 * @param error - The error to log
 * @param context - Error context
 * @param category - Error category
 */
export function logError(
  error: Error,
  context: ErrorContext,
  category: ErrorCategory
): void {
  const timestamp = new Date().toISOString();
  
  console.error(`[ErrorHandler] ${category} Error in ${context.operation}:`, {
    timestamp,
    category,
    operation: context.operation,
    taskId: context.taskId,
    userId: context.userId,
    provider: context.provider,
    message: error.message,
    stack: error.stack,
    additionalInfo: context.additionalInfo,
  });
}

/**
 * Handle error with unified error handling logic
 * 
 * This function:
 * 1. Categorizes the error
 * 2. Logs the error with context
 * 3. Updates task status if taskId is provided
 * 4. Returns user-friendly error response
 * 
 * @param error - The error to handle
 * @param context - Error context
 * @returns Error response object
 */
export async function handleError(
  error: Error,
  context: ErrorContext
): Promise<ErrorResponse> {
  // Categorize error
  const category = categorizeError(error);

  // Log error with full context
  logError(error, context, category);

  // Update task status if taskId is provided
  if (context.taskId) {
    try {
      const userMessage = getUserFriendlyMessage(error, category);
      await updateTaskStatus(context.taskId, 'failed', {
        errorMessage: userMessage,
      });
      console.log(`[ErrorHandler] Updated task ${context.taskId} status to failed`);
    } catch (updateError) {
      console.error('[ErrorHandler] Failed to update task status:', {
        taskId: context.taskId,
        error: updateError instanceof Error ? updateError.message : 'Unknown error',
      });
      // Don't throw here - we still want to return the original error
    }
  }

  // Build error response
  const userMessage = getUserFriendlyMessage(error, category);
  const errorResponse: ErrorResponse = {
    error: userMessage,
    category,
  };

  // Include detailed error message in development mode
  if (process.env.NODE_ENV === 'development') {
    errorResponse.details = error.message;
  }

  return errorResponse;
}

/**
 * Handle database error specifically
 * 
 * @param error - Database error
 * @param context - Error context
 * @returns Error response object
 */
export async function handleDatabaseError(
  error: Error,
  context: ErrorContext
): Promise<ErrorResponse> {
  const enhancedContext: ErrorContext = {
    ...context,
    additionalInfo: {
      ...context.additionalInfo,
      errorType: 'database',
    },
  };

  return handleError(error, enhancedContext);
}

/**
 * Handle API error specifically
 * 
 * @param error - API error
 * @param context - Error context
 * @returns Error response object
 */
export async function handleAPIError(
  error: Error,
  context: ErrorContext
): Promise<ErrorResponse> {
  const enhancedContext: ErrorContext = {
    ...context,
    additionalInfo: {
      ...context.additionalInfo,
      errorType: 'api',
    },
  };

  return handleError(error, enhancedContext);
}

/**
 * Handle timeout error specifically
 * 
 * @param taskId - Task ID that timed out
 * @param context - Error context
 * @returns Error response object
 */
export async function handleTimeoutError(
  taskId: string,
  context: ErrorContext
): Promise<ErrorResponse> {
  const error = new Error('Task timeout after 60 seconds');
  const enhancedContext: ErrorContext = {
    ...context,
    taskId,
    additionalInfo: {
      ...context.additionalInfo,
      errorType: 'timeout',
      timeoutDuration: '60s',
    },
  };

  return handleError(error, enhancedContext);
}

/**
 * Handle validation error specifically
 * 
 * @param message - Validation error message
 * @param context - Error context
 * @returns Error response object
 */
export async function handleValidationError(
  message: string,
  context: ErrorContext
): Promise<ErrorResponse> {
  const error = new Error(message);
  const enhancedContext: ErrorContext = {
    ...context,
    additionalInfo: {
      ...context.additionalInfo,
      errorType: 'validation',
    },
  };

  return handleError(error, enhancedContext);
}

/**
 * Wrap async function with error handling
 * 
 * @param fn - Async function to wrap
 * @param context - Error context
 * @returns Wrapped function that handles errors
 */
export function withErrorHandling<T>(
  fn: () => Promise<T>,
  context: ErrorContext
): Promise<T> {
  return fn().catch(async (error) => {
    await handleError(error instanceof Error ? error : new Error(String(error)), context);
    throw error; // Re-throw after handling
  });
}

/**
 * Check if error is retryable
 * 
 * @param error - Error to check
 * @returns True if error is retryable
 */
export function isRetryableError(error: Error): boolean {
  const category = categorizeError(error);
  
  // Retryable error categories
  return (
    category === ErrorCategory.NETWORK ||
    category === ErrorCategory.TIMEOUT ||
    (category === ErrorCategory.DATABASE && error.message.includes('timeout'))
  );
}

/**
 * Get retry delay based on attempt number (exponential backoff)
 * 
 * @param attempt - Current attempt number (0-indexed)
 * @param baseDelay - Base delay in milliseconds (default: 1000)
 * @returns Delay in milliseconds
 */
export function getRetryDelay(attempt: number, baseDelay: number = 1000): number {
  return baseDelay * Math.pow(2, attempt);
}
