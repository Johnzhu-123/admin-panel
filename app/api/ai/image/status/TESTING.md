# Status API Testing Guide

This document provides manual testing instructions for the `/api/ai/image/status` endpoint.

## Endpoint Overview

**URL**: `GET /api/ai/image/status?taskId={taskId}`

**Purpose**: Query the status of an async image generation task

## Test Cases

### Test Case 1: Missing taskId Parameter

**Request**:
```bash
curl http://localhost:3000/api/ai/image/status
```

**Expected Response** (400 Bad Request):
```json
{
  "error": "Missing required parameter: taskId",
  "details": "Please provide a taskId query parameter"
}
```

### Test Case 2: Invalid taskId Format

**Request**:
```bash
curl "http://localhost:3000/api/ai/image/status?taskId=invalid-id"
```

**Expected Response** (400 Bad Request):
```json
{
  "error": "Invalid taskId format",
  "details": "taskId must be a valid UUID"
}
```

### Test Case 3: Task Not Found

**Request**:
```bash
curl "http://localhost:3000/api/ai/image/status?taskId=550e8400-e29b-41d4-a716-446655440000"
```

**Expected Response** (404 Not Found):
```json
{
  "error": "Task not found",
  "details": "No task found with ID: 550e8400-e29b-41d4-a716-446655440000"
}
```

### Test Case 4: Pending Task

**Setup**:
1. Create a task using POST /api/ai/image with ENABLE_ASYNC_IMAGE_GENERATION=true
2. Immediately query the status

**Request**:
```bash
curl "http://localhost:3000/api/ai/image/status?taskId={taskId}"
```

**Expected Response** (200 OK):
```json
{
  "taskId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "pending",
  "createdAt": "2024-01-01T00:00:00.000Z"
}
```

**Validation**:
- ✓ Response includes taskId
- ✓ Status is "pending"
- ✓ createdAt is present
- ✓ No resultImage field
- ✓ No errorMessage field
- ✓ No completedAt field

### Test Case 5: Processing Task

**Setup**:
1. Create a task
2. Wait a moment for background processing to start
3. Query the status

**Request**:
```bash
curl "http://localhost:3000/api/ai/image/status?taskId={taskId}"
```

**Expected Response** (200 OK):
```json
{
  "taskId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "processing",
  "createdAt": "2024-01-01T00:00:00.000Z"
}
```

**Validation**:
- ✓ Status is "processing"
- ✓ No resultImage field
- ✓ No errorMessage field
- ✓ No completedAt field

### Test Case 6: Completed Task

**Setup**:
1. Create a task
2. Wait for generation to complete (15-30 seconds)
3. Query the status

**Request**:
```bash
curl "http://localhost:3000/api/ai/image/status?taskId={taskId}"
```

**Expected Response** (200 OK):
```json
{
  "taskId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "completed",
  "resultImage": "iVBORw0KGgoAAAANSUhEUgAA...(base64 data)",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "completedAt": "2024-01-01T00:00:30.000Z"
}
```

**Validation**:
- ✓ Status is "completed"
- ✓ resultImage contains base64 data
- ✓ completedAt is present
- ✓ No errorMessage field

### Test Case 7: Failed Task

**Setup**:
1. Create a task with invalid API key or parameters
2. Wait for generation to fail
3. Query the status

**Request**:
```bash
curl "http://localhost:3000/api/ai/image/status?taskId={taskId}"
```

**Expected Response** (200 OK):
```json
{
  "taskId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "failed",
  "errorMessage": "API rate limit exceeded",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "completedAt": "2024-01-01T00:00:05.000Z"
}
```

**Validation**:
- ✓ Status is "failed"
- ✓ errorMessage contains error details
- ✓ completedAt is present
- ✓ No resultImage field

### Test Case 8: Database Error

**Setup**:
1. Temporarily break database connection (e.g., wrong connection string)
2. Query any taskId

**Expected Response** (500 Internal Server Error):
```json
{
  "error": "Internal server error",
  "details": "Database connection failed" // Only in development mode
}
```

## Integration Test Flow

Complete end-to-end test:

```bash
# 1. Create a task
TASK_RESPONSE=$(curl -X POST http://localhost:3000/api/ai/image \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "A beautiful sunset over mountains",
    "provider": "openai",
    "apiKey": "your-api-key",
    "userId": "test-user"
  }')

# Extract taskId
TASK_ID=$(echo $TASK_RESPONSE | jq -r '.taskId')
echo "Task ID: $TASK_ID"

# 2. Poll status every 2 seconds
for i in {1..30}; do
  echo "Polling attempt $i..."
  STATUS_RESPONSE=$(curl "http://localhost:3000/api/ai/image/status?taskId=$TASK_ID")
  echo $STATUS_RESPONSE | jq '.'
  
  STATUS=$(echo $STATUS_RESPONSE | jq -r '.status')
  
  if [ "$STATUS" = "completed" ]; then
    echo "✓ Task completed successfully!"
    break
  elif [ "$STATUS" = "failed" ]; then
    echo "✗ Task failed!"
    break
  fi
  
  sleep 2
done
```

## Performance Validation

### Response Time

The status API should respond quickly:
- **Target**: < 500ms for database query
- **Maximum**: < 1000ms

**Test**:
```bash
time curl "http://localhost:3000/api/ai/image/status?taskId={taskId}"
```

### Concurrent Requests

Test multiple simultaneous status queries:

```bash
# Run 10 concurrent requests
for i in {1..10}; do
  curl "http://localhost:3000/api/ai/image/status?taskId={taskId}" &
done
wait
```

All requests should complete successfully without errors.

## Requirements Validation

This endpoint validates the following requirements:

- **Requirement 3.1**: Returns current status for valid task ID ✓
- **Requirement 3.2**: Returns 404 for non-existent task ID ✓
- **Requirement 3.3**: Returns resultImage when status is "completed" ✓
- **Requirement 3.4**: Returns errorMessage when status is "failed" ✓
- **Requirement 3.5**: Returns only status for "pending"/"processing" ✓
- **Requirement 6.2**: Provides GET /api/ai/image/status endpoint ✓

## Logging Verification

Check console logs for proper logging:

```
[StatusAPI] Querying task status: 550e8400-e29b-41d4-a716-446655440000
[TaskManager] Querying task status: 550e8400-e29b-41d4-a716-446655440000
[TaskManager] Task found: { taskId: '...', status: 'completed', hasResult: true, hasError: false }
[StatusAPI] Task completed, returning result: { taskId: '...', imageLength: 12345 }
[StatusAPI] Request completed: { taskId: '...', status: 'completed', duration: '45ms' }
```

## Error Scenarios

### Scenario 1: Database Connection Lost

**Trigger**: Stop database or use invalid connection string

**Expected**: 500 error with appropriate message

### Scenario 2: Malformed Database Response

**Trigger**: Corrupt data in database

**Expected**: Graceful error handling, 500 error

### Scenario 3: Very Large Result Image

**Trigger**: Generate high-resolution image

**Expected**: Response should still work, but may be slower

## Security Validation

### SQL Injection Prevention

Test with malicious taskId values:

```bash
curl "http://localhost:3000/api/ai/image/status?taskId='; DROP TABLE image_generation_tasks; --"
```

**Expected**: 400 error (invalid UUID format), no SQL execution

### Authorization (Future Enhancement)

Currently, any user can query any task. Future enhancement should:
- Verify user identity
- Ensure user can only query their own tasks

## Notes

- The API route tests are not included in the Jest test suite because Jest is configured to only test files in the `lib` directory
- Manual testing is required for API routes
- Consider adding integration tests using a tool like Supertest in the future
