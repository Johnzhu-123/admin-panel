# Error Handler Documentation

## Overview

The unified error handler provides centralized error handling, logging, and user-friendly error messages for the async image generation system. It categorizes errors, logs them with context, updates task status when applicable, and returns appropriate error responses.

## Features

- **Error Categorization**: Automatically categorizes errors into specific types (Database, Timeout, API, Network, Content Policy, Validation, Unknown)
- **User-Friendly Messages**: Converts technical error messages into user-friendly descriptions
- **Automatic Logging**: Logs errors with full context including task ID, user ID, provider, and additional information
- **Task Status Updates**: Automatically updates task status to 'failed' when a task ID is provided
- **Retry Detection**: Identifies which errors are retryable and provides exponential backoff delays
- **Development Mode Support**: Includes detailed error information in development mode

## Error Categories

### DATABASE
Database-related errors including connection failures, query timeouts, and SQL errors.

**Examples:**
- `POSTGRES connection failed`
- `Database query timeout`
- `SQL syntax error`

**User Message:** "Database error occurred. Please try again later."

### TIMEOUT
Request or operation timeout errors.

**Examples:**
- `Request timeout`
- `Operation timed out`
- `Time limit exceeded`

**User Message:** "Request timeout. The operation took too long to complete."

### API
API-related errors including authentication, rate limits, and quota issues.

**Examples:**
- `API key invalid`
- `Rate limit exceeded`
- `Unauthorized access`
- `Quota exceeded`

**User Messages:**
- Rate limit: "API rate limit exceeded. Please try again later."
- Authentication: "API authentication failed. Please check your API key."
- Quota: "API quota exceeded. Please check your account limits."
- Generic: "API error occurred. Please check your configuration."

### NETWORK
Network connectivity errors.

**Examples:**
- `Network connection failed`
- `ECONNREFUSED`
- `fetch failed`

**User Message:** "Network error occurred. Please check your connection and try again."

### CONTENT_POLICY
Content policy violations from AI providers.

**Examples:**
- `Content policy violation`
- `Safety filter triggered`
- `Inappropriate content blocked`

**User Message:** "Content policy violation. Please modify your prompt and try again."

### VALIDATION
Input validation errors.

**Examples:**
- `Missing required parameter: prompt`
- `Invalid parameter format`

**User Message:** Returns the original error message (already user-friendly)

### UNKNOWN
Unrecognized errors.

**User Message:** "An unexpected error occurred. Please try again."

## Usage

### Basic Error Handling

```typescript
import { handleError, ErrorContext } from '@/lib/async-image-generation/error-handler';

try {
  // Your code here
  await someOperation();
} catch (error) {
  const context: ErrorContext = {
    operation: 'create-task',
    taskId: 'task-123',
    userId: 'user-456',
  };
  
  const errorResponse = await handleError(
    error instanceof Error ? error : new Error(String(error)),
    context
  );
  
  return NextResponse.json(errorResponse, { status: 500 });
}
```

### Specific Error Handlers

#### Database Errors

```typescript
import { handleDatabaseError } from '@/lib/async-image-generation/error-handler';

try {
  await sql`SELECT * FROM tasks WHERE id = ${taskId}`;
} catch (error) {
  const errorResponse = await handleDatabaseError(
    error instanceof Error ? error : new Error(String(error)),
    {
      operation: 'query-task',
      taskId,
    }
  );
  return NextResponse.json(errorResponse, { status: 500 });
}
```

#### API Errors

```typescript
import { handleAPIError } from '@/lib/async-image-generation/error-handler';

try {
  const response = await fetch(apiEndpoint, options);
  if (!response.ok) {
    throw new Error(`API error: ${response.statusText}`);
  }
} catch (error) {
  const errorResponse = await handleAPIError(
    error instanceof Error ? error : new Error(String(error)),
    {
      operation: 'generate-image',
      taskId,
      provider: 'openai',
    }
  );
  return NextResponse.json(errorResponse, { status: 500 });
}
```

#### Timeout Errors

```typescript
import { handleTimeoutError } from '@/lib/async-image-generation/error-handler';

const timeoutPromise = new Promise((_, reject) => {
  setTimeout(() => reject(new Error('Timeout')), 60000);
});

try {
  await Promise.race([operation(), timeoutPromise]);
} catch (error) {
  if (error instanceof Error && error.message.includes('Timeout')) {
    const errorResponse = await handleTimeoutError(taskId, {
      operation: 'generate-image',
      userId,
    });
    return NextResponse.json(errorResponse, { status: 500 });
  }
}
```

#### Validation Errors

```typescript
import { handleValidationError } from '@/lib/async-image-generation/error-handler';

if (!prompt || !userId) {
  const errorResponse = await handleValidationError(
    'Missing required parameters: prompt and userId',
    {
      operation: 'validate-request',
      userId,
    }
  );
  return NextResponse.json(errorResponse, { status: 400 });
}
```

### Error Context

The `ErrorContext` interface provides structured information about where and why an error occurred:

```typescript
interface ErrorContext {
  operation: string;           // Required: Name of the operation (e.g., 'create-task')
  taskId?: string;            // Optional: Task ID (will trigger status update)
  userId?: string;            // Optional: User ID
  provider?: string;          // Optional: Provider name (e.g., 'openai', 'gemini')
  additionalInfo?: Record<string, any>; // Optional: Any additional context
}
```

### Retry Logic

Check if an error is retryable and get appropriate delay:

```typescript
import { isRetryableError, getRetryDelay } from '@/lib/async-image-generation/error-handler';

async function retryableOperation(maxRetries: number = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await someOperation();
    } catch (error) {
      if (error instanceof Error && isRetryableError(error)) {
        if (attempt < maxRetries - 1) {
          const delay = getRetryDelay(attempt);
          console.log(`Retrying after ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
      }
      throw error;
    }
  }
}
```

### Wrapping Functions with Error Handling

```typescript
import { withErrorHandling } from '@/lib/async-image-generation/error-handler';

const result = await withErrorHandling(
  async () => {
    // Your operation here
    return await someOperation();
  },
  {
    operation: 'some-operation',
    taskId,
    userId,
  }
);
```

## Logging

All errors are automatically logged with the following information:

- Timestamp
- Error category
- Operation name
- Task ID (if provided)
- User ID (if provided)
- Provider (if provided)
- Error message
- Stack trace
- Additional context

Example log output:

```
[ErrorHandler] API Error in generate-image: {
  timestamp: '2024-01-15T10:30:00.000Z',
  category: 'API',
  operation: 'generate-image',
  taskId: 'task-123',
  userId: 'user-456',
  provider: 'openai',
  message: 'Rate limit exceeded',
  stack: '...',
  additionalInfo: { ... }
}
```

## Task Status Updates

When a `taskId` is provided in the error context, the error handler automatically:

1. Updates the task status to 'failed'
2. Stores the user-friendly error message in the task record
3. Logs the status update

This ensures that users can see meaningful error messages when polling task status.

## Development vs Production

In **development mode** (`NODE_ENV=development`):
- Error responses include a `details` field with the original error message
- Full stack traces are logged

In **production mode**:
- Error responses only include user-friendly messages
- Detailed error information is logged but not exposed to users

## Best Practices

1. **Always provide context**: Include operation name, task ID, and user ID when available
2. **Use specific handlers**: Use `handleDatabaseError`, `handleAPIError`, etc. for better categorization
3. **Check retryability**: Use `isRetryableError()` before implementing retry logic
4. **Don't expose internals**: Let the error handler convert technical errors to user-friendly messages
5. **Log before throwing**: The error handler logs automatically, but you can add additional logging if needed

## Integration with Task Manager

The error handler integrates seamlessly with the task manager:

```typescript
import { generateAsync } from '@/lib/async-image-generation/image-generator';
import { handleError } from '@/lib/async-image-generation/error-handler';

try {
  await generateAsync(taskId, params);
} catch (error) {
  // Error handler will automatically update task status to 'failed'
  await handleError(
    error instanceof Error ? error : new Error(String(error)),
    {
      operation: 'generate-image',
      taskId,
      userId: params.userId,
      provider: params.provider,
    }
  );
}
```

## Testing

The error handler includes comprehensive unit tests covering:

- Error categorization for all error types
- User-friendly message generation
- Task status updates
- Development vs production mode behavior
- Retry logic
- Exponential backoff calculations

Run tests with:

```bash
npm test -- lib/async-image-generation/__tests__/error-handler.test.ts
```

## Requirements Validation

This error handler implementation validates the following requirements:

- **Requirement 4.4**: Database operation error handling and logging
- **Requirement 8.1**: Detailed error logging to console
- **Requirement 8.2**: SQL error and stack trace logging for database failures
- **Requirement 8.3**: Error details stored in task records for image generation failures
- **Requirement 8.4**: Timeout reason and task details logging
- **Requirement 8.5**: Logging for all critical operations

## API

### Functions

- `categorizeError(error: Error): ErrorCategory` - Categorize an error
- `getUserFriendlyMessage(error: Error, category: ErrorCategory): string` - Get user-friendly message
- `logError(error: Error, context: ErrorContext, category: ErrorCategory): void` - Log error with context
- `handleError(error: Error, context: ErrorContext): Promise<ErrorResponse>` - Main error handler
- `handleDatabaseError(error: Error, context: ErrorContext): Promise<ErrorResponse>` - Database error handler
- `handleAPIError(error: Error, context: ErrorContext): Promise<ErrorResponse>` - API error handler
- `handleTimeoutError(taskId: string, context: ErrorContext): Promise<ErrorResponse>` - Timeout error handler
- `handleValidationError(message: string, context: ErrorContext): Promise<ErrorResponse>` - Validation error handler
- `withErrorHandling<T>(fn: () => Promise<T>, context: ErrorContext): Promise<T>` - Wrap function with error handling
- `isRetryableError(error: Error): boolean` - Check if error is retryable
- `getRetryDelay(attempt: number, baseDelay?: number): number` - Get retry delay with exponential backoff

### Types

```typescript
enum ErrorCategory {
  DATABASE = 'DATABASE',
  TIMEOUT = 'TIMEOUT',
  API = 'API',
  VALIDATION = 'VALIDATION',
  NETWORK = 'NETWORK',
  CONTENT_POLICY = 'CONTENT_POLICY',
  UNKNOWN = 'UNKNOWN',
}

interface ErrorContext {
  operation: string;
  taskId?: string;
  userId?: string;
  provider?: string;
  additionalInfo?: Record<string, any>;
}

interface ErrorResponse {
  error: string;
  details?: string;
  category?: ErrorCategory;
}
```
