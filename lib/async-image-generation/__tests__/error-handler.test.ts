/**
 * Unit tests for error handler
 */

import {
  categorizeError,
  getUserFriendlyMessage,
  handleError,
  handleDatabaseError,
  handleAPIError,
  handleTimeoutError,
  handleValidationError,
  isRetryableError,
  getRetryDelay,
  ErrorCategory,
  ErrorContext,
} from '../error-handler';
import { updateTaskStatus } from '../task-manager';

// Mock the task manager
jest.mock('../task-manager', () => ({
  updateTaskStatus: jest.fn(),
}));

describe('Error Handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Suppress console.error in tests
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('categorizeError', () => {
    it('should categorize database errors', () => {
      const errors = [
        new Error('POSTGRES connection failed'),
        new Error('Database query timeout'),
        new Error('SQL syntax error'),
      ];

      errors.forEach((error) => {
        expect(categorizeError(error)).toBe(ErrorCategory.DATABASE);
      });
    });

    it('should categorize timeout errors', () => {
      const errors = [
        new Error('Request timeout'),
        new Error('Operation timed out'),
        new Error('Time limit exceeded'),
      ];

      errors.forEach((error) => {
        expect(categorizeError(error)).toBe(ErrorCategory.TIMEOUT);
      });
    });

    it('should categorize API errors', () => {
      const errors = [
        new Error('API key invalid'),
        new Error('Unauthorized access'),
        new Error('Rate limit exceeded'),
        new Error('Quota exceeded'),
      ];

      errors.forEach((error) => {
        expect(categorizeError(error)).toBe(ErrorCategory.API);
      });
    });

    it('should categorize network errors', () => {
      const errors = [
        new Error('Network connection failed'),
        new Error('ECONNREFUSED'),
        new Error('ENOTFOUND'),
        new Error('fetch failed'),
      ];

      errors.forEach((error) => {
        expect(categorizeError(error)).toBe(ErrorCategory.NETWORK);
      });
    });

    it('should categorize content policy errors', () => {
      const errors = [
        new Error('Content policy violation'),
        new Error('Safety filter triggered'),
        new Error('Inappropriate content blocked'),
      ];

      errors.forEach((error) => {
        expect(categorizeError(error)).toBe(ErrorCategory.CONTENT_POLICY);
      });
    });

    it('should categorize validation errors', () => {
      const errors = [
        new Error('Validation failed'),
        new Error('Invalid parameter'),
        new Error('Missing required field'),
      ];

      errors.forEach((error) => {
        expect(categorizeError(error)).toBe(ErrorCategory.VALIDATION);
      });
    });

    it('should categorize unknown errors', () => {
      const error = new Error('Something went wrong');
      expect(categorizeError(error)).toBe(ErrorCategory.UNKNOWN);
    });
  });

  describe('getUserFriendlyMessage', () => {
    it('should return friendly message for database errors', () => {
      const error = new Error('POSTGRES connection failed');
      const message = getUserFriendlyMessage(error, ErrorCategory.DATABASE);
      expect(message).toBe('Database error occurred. Please try again later.');
    });

    it('should return friendly message for timeout errors', () => {
      const error = new Error('Request timeout');
      const message = getUserFriendlyMessage(error, ErrorCategory.TIMEOUT);
      expect(message).toBe('Request timeout. The operation took too long to complete.');
    });

    it('should return specific message for rate limit errors', () => {
      const error = new Error('Rate limit exceeded');
      const message = getUserFriendlyMessage(error, ErrorCategory.API);
      expect(message).toBe('API rate limit exceeded. Please try again later.');
    });

    it('should return specific message for authentication errors', () => {
      const error = new Error('Unauthorized access');
      const message = getUserFriendlyMessage(error, ErrorCategory.API);
      expect(message).toBe('API authentication failed. Please check your API key.');
    });

    it('should return friendly message for network errors', () => {
      const error = new Error('Network connection failed');
      const message = getUserFriendlyMessage(error, ErrorCategory.NETWORK);
      expect(message).toBe('Network error occurred. Please check your connection and try again.');
    });

    it('should return friendly message for content policy errors', () => {
      const error = new Error('Content policy violation');
      const message = getUserFriendlyMessage(error, ErrorCategory.CONTENT_POLICY);
      expect(message).toBe('Content policy violation. Please modify your prompt and try again.');
    });

    it('should return original message for validation errors', () => {
      const error = new Error('Missing required field: prompt');
      const message = getUserFriendlyMessage(error, ErrorCategory.VALIDATION);
      expect(message).toBe('Missing required field: prompt');
    });

    it('should return generic message for unknown errors', () => {
      const error = new Error('Something went wrong');
      const message = getUserFriendlyMessage(error, ErrorCategory.UNKNOWN);
      expect(message).toBe('An unexpected error occurred. Please try again.');
    });
  });

  describe('handleError', () => {
    it('should handle error without taskId', async () => {
      const error = new Error('Test error');
      const context: ErrorContext = {
        operation: 'test-operation',
        userId: 'user123',
      };

      const response = await handleError(error, context);

      expect(response.error).toBeDefined();
      expect(response.category).toBe(ErrorCategory.UNKNOWN);
      expect(updateTaskStatus).not.toHaveBeenCalled();
    });

    it('should handle error with taskId and update task status', async () => {
      const error = new Error('Database connection failed');
      const context: ErrorContext = {
        operation: 'create-task',
        taskId: 'task-123',
        userId: 'user123',
      };

      const response = await handleError(error, context);

      expect(response.error).toBe('Database error occurred. Please try again later.');
      expect(response.category).toBe(ErrorCategory.DATABASE);
      expect(updateTaskStatus).toHaveBeenCalledWith(
        'task-123',
        'failed',
        { errorMessage: 'Database error occurred. Please try again later.' }
      );
    });

    it('should include details in development mode', async () => {
      const originalEnv = process.env.NODE_ENV;
      (process.env as any).NODE_ENV = 'development'; // 🔧 类型门禁: NODE_ENV 类型只读，测试内强写

      const error = new Error('Detailed error message');
      const context: ErrorContext = {
        operation: 'test-operation',
      };

      const response = await handleError(error, context);

      expect(response.details).toBe('Detailed error message');

      (process.env as any).NODE_ENV = originalEnv;
    });

    it('should not include details in production mode', async () => {
      const originalEnv = process.env.NODE_ENV;
      (process.env as any).NODE_ENV = 'production'; // 🔧 类型门禁: NODE_ENV 类型只读，测试内强写

      const error = new Error('Detailed error message');
      const context: ErrorContext = {
        operation: 'test-operation',
      };

      const response = await handleError(error, context);

      expect(response.details).toBeUndefined();

      (process.env as any).NODE_ENV = originalEnv;
    });

    it('should handle task status update failure gracefully', async () => {
      (updateTaskStatus as jest.Mock).mockRejectedValueOnce(
        new Error('Update failed')
      );

      const error = new Error('Test error');
      const context: ErrorContext = {
        operation: 'test-operation',
        taskId: 'task-123',
      };

      const response = await handleError(error, context);

      expect(response.error).toBeDefined();
      expect(updateTaskStatus).toHaveBeenCalled();
    });
  });

  describe('handleDatabaseError', () => {
    it('should handle database error with enhanced context', async () => {
      const error = new Error('POSTGRES query failed');
      const context: ErrorContext = {
        operation: 'query-task',
        taskId: 'task-123',
      };

      const response = await handleDatabaseError(error, context);

      expect(response.error).toBe('Database error occurred. Please try again later.');
      expect(response.category).toBe(ErrorCategory.DATABASE);
    });
  });

  describe('handleAPIError', () => {
    it('should handle API error with enhanced context', async () => {
      const error = new Error('API rate limit exceeded');
      const context: ErrorContext = {
        operation: 'generate-image',
        taskId: 'task-123',
        provider: 'openai',
      };

      const response = await handleAPIError(error, context);

      expect(response.error).toBe('API rate limit exceeded. Please try again later.');
      expect(response.category).toBe(ErrorCategory.API);
    });
  });

  describe('handleTimeoutError', () => {
    it('should handle timeout error', async () => {
      const context: ErrorContext = {
        operation: 'generate-image',
        userId: 'user123',
      };

      const response = await handleTimeoutError('task-123', context);

      expect(response.error).toBe('Request timeout. The operation took too long to complete.');
      expect(response.category).toBe(ErrorCategory.TIMEOUT);
      expect(updateTaskStatus).toHaveBeenCalledWith(
        'task-123',
        'failed',
        { errorMessage: 'Request timeout. The operation took too long to complete.' }
      );
    });
  });

  describe('handleValidationError', () => {
    it('should handle validation error', async () => {
      const message = 'Missing required parameter: prompt';
      const context: ErrorContext = {
        operation: 'validate-request',
        userId: 'user123',
      };

      const response = await handleValidationError(message, context);

      expect(response.error).toBe('Missing required parameter: prompt');
      expect(response.category).toBe(ErrorCategory.VALIDATION);
    });
  });

  describe('isRetryableError', () => {
    it('should identify retryable network errors', () => {
      const error = new Error('Network connection failed');
      expect(isRetryableError(error)).toBe(true);
    });

    it('should identify retryable timeout errors', () => {
      const error = new Error('Request timeout');
      expect(isRetryableError(error)).toBe(true);
    });

    it('should identify retryable database timeout errors', () => {
      const error = new Error('Database query timeout');
      expect(isRetryableError(error)).toBe(true);
    });

    it('should identify non-retryable validation errors', () => {
      const error = new Error('Invalid parameter');
      expect(isRetryableError(error)).toBe(false);
    });

    it('should identify non-retryable content policy errors', () => {
      const error = new Error('Content policy violation');
      expect(isRetryableError(error)).toBe(false);
    });

    it('should identify non-retryable API authentication errors', () => {
      const error = new Error('Unauthorized access');
      expect(isRetryableError(error)).toBe(false);
    });
  });

  describe('getRetryDelay', () => {
    it('should calculate exponential backoff delay', () => {
      expect(getRetryDelay(0)).toBe(1000); // 1s
      expect(getRetryDelay(1)).toBe(2000); // 2s
      expect(getRetryDelay(2)).toBe(4000); // 4s
      expect(getRetryDelay(3)).toBe(8000); // 8s
    });

    it('should use custom base delay', () => {
      expect(getRetryDelay(0, 500)).toBe(500);
      expect(getRetryDelay(1, 500)).toBe(1000);
      expect(getRetryDelay(2, 500)).toBe(2000);
    });
  });
});
