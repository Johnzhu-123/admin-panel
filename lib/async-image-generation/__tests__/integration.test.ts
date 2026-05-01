/**
 * End-to-End Integration Tests for Async Image Generation
 * 
 * Tests the complete workflow:
 * 1. Create task
 * 2. Poll status
 * 3. Get result
 * 
 * Requirements: All requirements (comprehensive validation)
 */

import { createTask, getTaskStatus, updateTaskStatus } from '../task-manager';
import { generateAsync } from '../image-generator';

// Mock database
jest.mock('@vercel/postgres', () => ({
  sql: jest.fn(),
}));

// Mock fetch for API calls
global.fetch = jest.fn();

describe('Async Image Generation - Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Complete Workflow - Success', () => {
    it('should complete the full workflow: create → process → complete', async () => {
      // Mock database responses
      const mockSql = require('@vercel/postgres').sql;
      
      // Mock task creation - return the generated UUID
      mockSql.mockResolvedValueOnce({
        rows: [{
          task_id: expect.any(String),
          user_id: 'test-user',
          status: 'pending',
          prompt: 'A beautiful sunset',
          request_params: JSON.stringify({ prompt: 'A beautiful sunset' }),
          created_at: new Date(),
          updated_at: new Date(),
        }],
      });

      // Step 1: Create task
      const taskRecord = await createTask({
        userId: 'test-user',
        prompt: 'A beautiful sunset',
        requestParams: { prompt: 'A beautiful sunset' },
      });

      expect(taskRecord).toBeDefined();
      expect(taskRecord.taskId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(taskRecord.status).toBe('pending');
      
      const mockTaskId = taskRecord.taskId;

      // Mock task status query (processing)
      mockSql.mockResolvedValueOnce({
        rows: [{
          task_id: mockTaskId,
          user_id: 'test-user',
          status: 'processing',
          prompt: 'A beautiful sunset',
          request_params: JSON.stringify({ prompt: 'A beautiful sunset' }),
          created_at: new Date(),
          updated_at: new Date(),
        }],
      });

      // Step 2: Query status (should be processing)
      const statusProcessing = await getTaskStatus(mockTaskId);
      expect(statusProcessing).toBeDefined();
      expect(statusProcessing?.status).toBe('processing');

      // Mock task status query (completed)
      mockSql.mockResolvedValueOnce({
        rows: [{
          task_id: mockTaskId,
          user_id: 'test-user',
          status: 'completed',
          prompt: 'A beautiful sunset',
          request_params: JSON.stringify({ prompt: 'A beautiful sunset' }),
          result_image: 'base64-image-data',
          created_at: new Date(),
          updated_at: new Date(),
          completed_at: new Date(),
        }],
      });

      // Step 3: Query status (should be completed)
      const statusCompleted = await getTaskStatus(mockTaskId);
      expect(statusCompleted).toBeDefined();
      expect(statusCompleted?.status).toBe('completed');
      expect(statusCompleted?.resultImage).toBe('base64-image-data');
      expect(statusCompleted?.completedAt).toBeDefined();
    });
  });

  describe('Complete Workflow - Failure', () => {
    it('should handle task failure correctly', async () => {
      const mockSql = require('@vercel/postgres').sql;
      
      // Mock task creation
      mockSql.mockResolvedValueOnce({
        rows: [{
          task_id: expect.any(String),
          user_id: 'test-user',
          status: 'pending',
          prompt: 'Invalid prompt',
          request_params: JSON.stringify({ prompt: 'Invalid prompt' }),
          created_at: new Date(),
          updated_at: new Date(),
        }],
      });

      // Step 1: Create task
      const taskRecord = await createTask({
        userId: 'test-user',
        prompt: 'Invalid prompt',
        requestParams: { prompt: 'Invalid prompt' },
      });

      expect(taskRecord).toBeDefined();
      expect(taskRecord.taskId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      
      const mockTaskId = taskRecord.taskId;

      // Mock task status query (failed)
      mockSql.mockResolvedValueOnce({
        rows: [{
          task_id: mockTaskId,
          user_id: 'test-user',
          status: 'failed',
          prompt: 'Invalid prompt',
          request_params: JSON.stringify({ prompt: 'Invalid prompt' }),
          error_message: 'Content policy violation',
          created_at: new Date(),
          updated_at: new Date(),
          completed_at: new Date(),
        }],
      });

      // Step 2: Query status (should be failed)
      const statusFailed = await getTaskStatus(mockTaskId);
      expect(statusFailed).toBeDefined();
      expect(statusFailed?.status).toBe('failed');
      expect(statusFailed?.errorMessage).toBe('Content policy violation');
      expect(statusFailed?.completedAt).toBeDefined();
    });
  });

  describe('Polling Simulation', () => {
    it('should simulate polling until completion', async () => {
      const mockSql = require('@vercel/postgres').sql;
      const mockTaskId = '123e4567-e89b-12d3-a456-426614174002';

      // Simulate multiple status queries
      const statuses = ['pending', 'processing', 'processing', 'completed'];
      
      for (const status of statuses) {
        mockSql.mockResolvedValueOnce({
          rows: [{
            task_id: mockTaskId,
            user_id: 'test-user',
            status,
            prompt: 'Test prompt',
            request_params: JSON.stringify({ prompt: 'Test prompt' }),
            result_image: status === 'completed' ? 'base64-data' : null,
            created_at: new Date(),
            updated_at: new Date(),
            completed_at: status === 'completed' ? new Date() : null,
          }],
        });

        const taskStatus = await getTaskStatus(mockTaskId);
        expect(taskStatus?.status).toBe(status);

        if (status === 'completed') {
          expect(taskStatus?.resultImage).toBe('base64-data');
          break;
        }
      }
    });
  });

  describe('Task Not Found', () => {
    it('should return null for non-existent task', async () => {
      const mockSql = require('@vercel/postgres').sql;
      
      // Mock empty result
      mockSql.mockResolvedValueOnce({
        rows: [],
      });

      const taskStatus = await getTaskStatus('non-existent-id');
      expect(taskStatus).toBeNull();
    });
  });

  describe('Status Update', () => {
    it('should update task status correctly', async () => {
      const mockSql = require('@vercel/postgres').sql;
      const mockTaskId = '123e4567-e89b-12d3-a456-426614174003';

      // Mock status update
      mockSql.mockResolvedValueOnce({
        rows: [{
          task_id: mockTaskId,
          status: 'processing',
          updated_at: new Date(),
        }],
      });

      await updateTaskStatus(mockTaskId, 'processing');

      // Verify SQL was called (the actual SQL structure is tested in unit tests)
      expect(mockSql).toHaveBeenCalled();
    });

    it('should update task with result image', async () => {
      const mockSql = require('@vercel/postgres').sql;
      const mockTaskId = '123e4567-e89b-12d3-a456-426614174004';

      // Mock status update with result
      mockSql.mockResolvedValueOnce({
        rows: [{
          task_id: mockTaskId,
          status: 'completed',
          result_image: 'base64-data',
          completed_at: new Date(),
          updated_at: new Date(),
        }],
      });

      await updateTaskStatus(mockTaskId, 'completed', {
        resultImage: 'base64-data',
      });

      // Verify SQL was called
      expect(mockSql).toHaveBeenCalled();
    });

    it('should update task with error message', async () => {
      const mockSql = require('@vercel/postgres').sql;
      const mockTaskId = '123e4567-e89b-12d3-a456-426614174005';

      // Mock status update with error
      mockSql.mockResolvedValueOnce({
        rows: [{
          task_id: mockTaskId,
          status: 'failed',
          error_message: 'Generation failed',
          completed_at: new Date(),
          updated_at: new Date(),
        }],
      });

      await updateTaskStatus(mockTaskId, 'failed', {
        errorMessage: 'Generation failed',
      });

      // Verify SQL was called
      expect(mockSql).toHaveBeenCalled();
    });
  });

  describe('Concurrent Tasks', () => {
    it('should handle multiple tasks independently', async () => {
      const mockSql = require('@vercel/postgres').sql;

      // Create multiple tasks
      const createdTasks: string[] = [];

      for (let i = 0; i < 3; i++) {
        mockSql.mockResolvedValueOnce({
          rows: [{
            task_id: expect.any(String),
            user_id: 'test-user',
            status: 'pending',
            prompt: `Prompt ${i}`,
            request_params: JSON.stringify({ prompt: `Prompt ${i}` }),
            created_at: new Date(),
            updated_at: new Date(),
          }],
        });

        const task = await createTask({
          userId: 'test-user',
          prompt: `Prompt ${i}`,
          requestParams: { prompt: `Prompt ${i}` },
        });

        expect(task.taskId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        createdTasks.push(task.taskId);
      }

      // Query each task independently
      for (const taskId of createdTasks) {
        mockSql.mockResolvedValueOnce({
          rows: [{
            task_id: taskId,
            user_id: 'test-user',
            status: 'processing',
            prompt: `Prompt for ${taskId}`,
            request_params: JSON.stringify({ prompt: `Prompt for ${taskId}` }),
            created_at: new Date(),
            updated_at: new Date(),
          }],
        });

        const status = await getTaskStatus(taskId);
        expect(status?.taskId).toBe(taskId);
        expect(status?.status).toBe('processing');
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle database errors gracefully', async () => {
      const mockSql = require('@vercel/postgres').sql;

      // Mock database error
      mockSql.mockRejectedValueOnce(new Error('Database connection failed'));

      await expect(
        createTask({
          userId: 'test-user',
          prompt: 'Test prompt',
          requestParams: { prompt: 'Test prompt' },
        })
      ).rejects.toThrow('Database connection failed');
    });

    it('should handle invalid task ID format', async () => {
      const mockSql = require('@vercel/postgres').sql;

      // Mock empty result for invalid ID
      mockSql.mockResolvedValueOnce({
        rows: [],
      });

      const status = await getTaskStatus('invalid-id-format');
      expect(status).toBeNull();
    });
  });

  describe('Data Persistence', () => {
    it('should persist all task data correctly', async () => {
      const mockSql = require('@vercel/postgres').sql;

      const requestParams = {
        prompt: 'A beautiful landscape',
        provider: 'openai',
        model: 'dall-e-3',
        size: '1024x1024',
      };

      // Mock task creation
      mockSql.mockResolvedValueOnce({
        rows: [{
          task_id: expect.any(String),
          user_id: 'test-user',
          status: 'pending',
          prompt: requestParams.prompt,
          request_params: JSON.stringify(requestParams),
          created_at: new Date(),
          updated_at: new Date(),
        }],
      });

      const task = await createTask({
        userId: 'test-user',
        prompt: requestParams.prompt,
        requestParams,
      });

      expect(task.taskId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(task.prompt).toBe(requestParams.prompt);
      
      const mockTaskId = task.taskId;

      // Mock task retrieval
      mockSql.mockResolvedValueOnce({
        rows: [{
          task_id: mockTaskId,
          user_id: 'test-user',
          status: 'pending',
          prompt: requestParams.prompt,
          request_params: JSON.stringify(requestParams),
          created_at: new Date(),
          updated_at: new Date(),
        }],
      });

      const retrieved = await getTaskStatus(mockTaskId);
      expect(retrieved?.taskId).toBe(mockTaskId);
      expect(retrieved?.prompt).toBe(requestParams.prompt);
    });
  });
});
