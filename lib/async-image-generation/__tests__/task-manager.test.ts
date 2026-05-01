/**
 * Unit tests for Task Manager
 */

// Mock @vercel/postgres before importing
const mockSql = jest.fn();
jest.mock('@vercel/postgres', () => ({
  sql: mockSql
}));

// Mock crypto.randomUUID
const mockRandomUUID = jest.fn(() => '550e8400-e29b-41d4-a716-446655440000');
jest.mock('crypto', () => ({
  randomUUID: mockRandomUUID
}));

import { createTask, updateTaskStatus, getTaskStatus, cleanupExpiredTasks } from '../task-manager';
import type { CreateTaskParams } from '../task-manager';

describe('Task Manager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRandomUUID.mockReturnValue('550e8400-e29b-41d4-a716-446655440000');
  });

  describe('createTask', () => {
    it('should create task with valid parameters', async () => {
      mockSql.mockResolvedValueOnce({} as any);

      const params: CreateTaskParams = {
        userId: 'user123',
        prompt: 'A beautiful sunset',
        requestParams: { model: 'dall-e-3', size: '1024x1024' }
      };

      const task = await createTask(params);

      expect(task.taskId).toBe('550e8400-e29b-41d4-a716-446655440000');
      expect(task.status).toBe('pending');
      expect(task.userId).toBe(params.userId);
      expect(task.prompt).toBe(params.prompt);
      expect(task.requestParams).toEqual(params.requestParams);
      expect(task.createdAt).toBeInstanceOf(Date);
      expect(task.updatedAt).toBeInstanceOf(Date);
      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('should throw error when userId is missing', async () => {
      const params: CreateTaskParams = {
        userId: '',
        prompt: 'A beautiful sunset',
        requestParams: {}
      };

      await expect(createTask(params)).rejects.toThrow('Missing required parameters');
    });

    it('should throw error when prompt is missing', async () => {
      const params: CreateTaskParams = {
        userId: 'user123',
        prompt: '',
        requestParams: {}
      };

      await expect(createTask(params)).rejects.toThrow('Missing required parameters');
    });

    it('should handle database errors gracefully', async () => {
      mockSql.mockRejectedValueOnce(new Error('Database connection failed'));

      const params: CreateTaskParams = {
        userId: 'user123',
        prompt: 'A beautiful sunset',
        requestParams: {}
      };

      await expect(createTask(params)).rejects.toThrow('Failed to create task');
    });
  });

  describe('updateTaskStatus', () => {
    it('should update task status without additional data', async () => {
      mockSql.mockResolvedValueOnce({} as any);

      await updateTaskStatus('task-123', 'processing');

      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('should update task status with result image', async () => {
      mockSql.mockResolvedValueOnce({} as any);

      await updateTaskStatus('task-123', 'completed', {
        resultImage: 'base64-image-data'
      });

      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('should update task status with error message', async () => {
      mockSql.mockResolvedValueOnce({} as any);

      await updateTaskStatus('task-123', 'failed', {
        errorMessage: 'Generation failed'
      });

      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('should throw error when taskId is missing', async () => {
      await expect(updateTaskStatus('', 'processing')).rejects.toThrow('Missing required parameter');
    });

    it('should handle database errors gracefully', async () => {
      mockSql.mockRejectedValueOnce(new Error('Database update failed'));

      await expect(updateTaskStatus('task-123', 'processing')).rejects.toThrow('Failed to update task status');
    });
  });

  describe('getTaskStatus', () => {
    it('should return task record when found', async () => {
      mockSql.mockResolvedValueOnce({
        rows: [{
          task_id: 'task-123',
          user_id: 'user123',
          status: 'completed',
          prompt: 'A beautiful sunset',
          request_params: JSON.stringify({ model: 'dall-e-3' }),
          result_image: 'base64-image-data',
          error_message: null,
          created_at: new Date('2024-01-01T00:00:00Z'),
          updated_at: new Date('2024-01-01T00:01:00Z'),
          completed_at: new Date('2024-01-01T00:01:00Z')
        }]
      } as any);

      const task = await getTaskStatus('task-123');

      expect(task).not.toBeNull();
      expect(task?.taskId).toBe('task-123');
      expect(task?.status).toBe('completed');
      expect(task?.resultImage).toBe('base64-image-data');
      expect(task?.completedAt).toBeInstanceOf(Date);
    });

    it('should return null when task not found', async () => {
      mockSql.mockResolvedValueOnce({
        rows: []
      } as any);

      const task = await getTaskStatus('non-existent-task');

      expect(task).toBeNull();
    });

    it('should throw error when taskId is missing', async () => {
      await expect(getTaskStatus('')).rejects.toThrow('Missing required parameter');
    });

    it('should handle database errors gracefully', async () => {
      mockSql.mockRejectedValueOnce(new Error('Database query failed'));

      await expect(getTaskStatus('task-123')).rejects.toThrow('Failed to get task status');
    });

    it('should handle malformed request_params gracefully', async () => {
      mockSql.mockResolvedValueOnce({
        rows: [{
          task_id: 'task-123',
          user_id: 'user123',
          status: 'pending',
          prompt: 'A beautiful sunset',
          request_params: 'invalid-json',
          result_image: null,
          error_message: null,
          created_at: new Date('2024-01-01T00:00:00Z'),
          updated_at: new Date('2024-01-01T00:00:00Z'),
          completed_at: null
        }]
      } as any);

      const task = await getTaskStatus('task-123');

      expect(task).not.toBeNull();
      expect(task?.requestParams).toEqual({});
    });
  });

  describe('cleanupExpiredTasks', () => {
    it('should delete expired tasks and return count', async () => {
      mockSql.mockResolvedValueOnce({
        rowCount: 5
      } as any);

      const cutoffDate = new Date('2024-01-01T00:00:00Z');
      const deletedCount = await cleanupExpiredTasks(cutoffDate);

      expect(deletedCount).toBe(5);
      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('should return 0 when no tasks to delete', async () => {
      mockSql.mockResolvedValueOnce({
        rowCount: 0
      } as any);

      const cutoffDate = new Date('2024-01-01T00:00:00Z');
      const deletedCount = await cleanupExpiredTasks(cutoffDate);

      expect(deletedCount).toBe(0);
    });

    it('should handle database errors gracefully', async () => {
      mockSql.mockRejectedValueOnce(new Error('Database delete failed'));

      const cutoffDate = new Date('2024-01-01T00:00:00Z');

      await expect(cleanupExpiredTasks(cutoffDate)).rejects.toThrow('Failed to cleanup expired tasks');
    });
  });
});
