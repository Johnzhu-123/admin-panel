/**
 * @jest-environment node
 *
 * Unit tests for Image Generation Status API
 * Tests the GET /api/ai/image/status endpoint
 *
 * 🔧 FIX (2026-06-11): 全局 jest 环境为 jsdom，但 jsdom 无 Web fetch 全局
 * （Request/Response），import next/server 即抛 "Request is not defined"，
 * 套件从未跑起来。API 路由测试本就该跑 node 环境（Node≥18 自带 fetch 全局）。
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { NextRequest } from 'next/server';
import { GET } from '../route';
import * as taskManager from '@/lib/async-image-generation/task-manager';

// Mock the task manager
jest.mock('@/lib/async-image-generation/task-manager');

describe('GET /api/ai/image/status', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Parameter Validation', () => {
    it('should return 400 when taskId is missing', async () => {
      const request = new NextRequest('http://localhost:3000/api/ai/image/status');
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('Missing required parameter: taskId');
    });

    it('should return 400 when taskId is not a valid UUID', async () => {
      const request = new NextRequest('http://localhost:3000/api/ai/image/status?taskId=invalid-id');
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('Invalid taskId format');
    });

    it('should accept valid UUID format', async () => {
      const validUUID = '550e8400-e29b-41d4-a716-446655440000';
      const mockGetTaskStatus = taskManager.getTaskStatus as jest.MockedFunction<typeof taskManager.getTaskStatus>;
      mockGetTaskStatus.mockResolvedValue(null);

      const request = new NextRequest(`http://localhost:3000/api/ai/image/status?taskId=${validUUID}`);
      const response = await GET(request);

      expect(mockGetTaskStatus).toHaveBeenCalledWith(validUUID);
    });
  });

  describe('Task Not Found', () => {
    it('should return 404 when task does not exist', async () => {
      const taskId = '550e8400-e29b-41d4-a716-446655440000';
      const mockGetTaskStatus = taskManager.getTaskStatus as jest.MockedFunction<typeof taskManager.getTaskStatus>;
      mockGetTaskStatus.mockResolvedValue(null);

      const request = new NextRequest(`http://localhost:3000/api/ai/image/status?taskId=${taskId}`);
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error).toBe('Task not found');
      expect(data.details).toContain(taskId);
    });
  });

  describe('Task Status Responses', () => {
    const taskId = '550e8400-e29b-41d4-a716-446655440000';
    const baseTask = {
      taskId,
      userId: 'user123',
      prompt: 'A beautiful sunset',
      requestParams: { model: 'dall-e-3' },
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-01T00:00:00Z'),
    };

    it('should return pending status without result or error', async () => {
      const mockGetTaskStatus = taskManager.getTaskStatus as jest.MockedFunction<typeof taskManager.getTaskStatus>;
      mockGetTaskStatus.mockResolvedValue({
        ...baseTask,
        status: 'pending',
      });

      const request = new NextRequest(`http://localhost:3000/api/ai/image/status?taskId=${taskId}`);
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.taskId).toBe(taskId);
      expect(data.status).toBe('pending');
      expect(data.createdAt).toBe('2024-01-01T00:00:00.000Z');
      expect(data.resultImage).toBeUndefined();
      expect(data.errorMessage).toBeUndefined();
      expect(data.completedAt).toBeUndefined();
    });

    it('should return processing status without result or error', async () => {
      const mockGetTaskStatus = taskManager.getTaskStatus as jest.MockedFunction<typeof taskManager.getTaskStatus>;
      mockGetTaskStatus.mockResolvedValue({
        ...baseTask,
        status: 'processing',
      });

      const request = new NextRequest(`http://localhost:3000/api/ai/image/status?taskId=${taskId}`);
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe('processing');
      expect(data.resultImage).toBeUndefined();
      expect(data.errorMessage).toBeUndefined();
    });

    it('should return completed status with result image', async () => {
      const mockGetTaskStatus = taskManager.getTaskStatus as jest.MockedFunction<typeof taskManager.getTaskStatus>;
      mockGetTaskStatus.mockResolvedValue({
        ...baseTask,
        status: 'completed',
        resultImage: 'base64-encoded-image-data',
        completedAt: new Date('2024-01-01T00:01:00Z'),
      });

      const request = new NextRequest(`http://localhost:3000/api/ai/image/status?taskId=${taskId}`);
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe('completed');
      expect(data.resultImage).toBe('base64-encoded-image-data');
      expect(data.completedAt).toBe('2024-01-01T00:01:00.000Z');
      expect(data.errorMessage).toBeUndefined();
    });

    it('should return failed status with error message', async () => {
      const mockGetTaskStatus = taskManager.getTaskStatus as jest.MockedFunction<typeof taskManager.getTaskStatus>;
      mockGetTaskStatus.mockResolvedValue({
        ...baseTask,
        status: 'failed',
        errorMessage: 'API rate limit exceeded',
        completedAt: new Date('2024-01-01T00:01:00Z'),
      });

      const request = new NextRequest(`http://localhost:3000/api/ai/image/status?taskId=${taskId}`);
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe('failed');
      expect(data.errorMessage).toBe('API rate limit exceeded');
      expect(data.completedAt).toBe('2024-01-01T00:01:00.000Z');
      expect(data.resultImage).toBeUndefined();
    });
  });

  describe('Error Handling', () => {
    it('should return 500 when database query fails', async () => {
      const taskId = '550e8400-e29b-41d4-a716-446655440000';
      const mockGetTaskStatus = taskManager.getTaskStatus as jest.MockedFunction<typeof taskManager.getTaskStatus>;
      mockGetTaskStatus.mockRejectedValue(new Error('Database connection failed'));

      const request = new NextRequest(`http://localhost:3000/api/ai/image/status?taskId=${taskId}`);
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe('Internal server error');
    });

    it('should include error details in development mode', async () => {
      const originalEnv = process.env.NODE_ENV;
      (process.env as any).NODE_ENV = 'development'; // 🔧 类型门禁: NODE_ENV 类型只读，测试内强写

      const taskId = '550e8400-e29b-41d4-a716-446655440000';
      const mockGetTaskStatus = taskManager.getTaskStatus as jest.MockedFunction<typeof taskManager.getTaskStatus>;
      mockGetTaskStatus.mockRejectedValue(new Error('Database connection failed'));

      const request = new NextRequest(`http://localhost:3000/api/ai/image/status?taskId=${taskId}`);
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.details).toBe('Database connection failed');

      (process.env as any).NODE_ENV = originalEnv;
    });

    it('should not include error details in production mode', async () => {
      const originalEnv = process.env.NODE_ENV;
      (process.env as any).NODE_ENV = 'production'; // 🔧 类型门禁: NODE_ENV 类型只读，测试内强写

      const taskId = '550e8400-e29b-41d4-a716-446655440000';
      const mockGetTaskStatus = taskManager.getTaskStatus as jest.MockedFunction<typeof taskManager.getTaskStatus>;
      mockGetTaskStatus.mockRejectedValue(new Error('Database connection failed'));

      const request = new NextRequest(`http://localhost:3000/api/ai/image/status?taskId=${taskId}`);
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.details).toBeUndefined();

      (process.env as any).NODE_ENV = originalEnv;
    });
  });

  describe('Response Format', () => {
    it('should return valid JSON for all responses', async () => {
      const taskId = '550e8400-e29b-41d4-a716-446655440000';
      const mockGetTaskStatus = taskManager.getTaskStatus as jest.MockedFunction<typeof taskManager.getTaskStatus>;
      mockGetTaskStatus.mockResolvedValue({
        taskId,
        userId: 'user123',
        status: 'pending',
        prompt: 'Test prompt',
        requestParams: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const request = new NextRequest(`http://localhost:3000/api/ai/image/status?taskId=${taskId}`);
      const response = await GET(request);
      
      // Should be able to parse JSON without errors
      const data = await response.json();
      expect(data).toBeDefined();
      expect(typeof data).toBe('object');
    });

    it('should include all required fields in successful response', async () => {
      const taskId = '550e8400-e29b-41d4-a716-446655440000';
      const mockGetTaskStatus = taskManager.getTaskStatus as jest.MockedFunction<typeof taskManager.getTaskStatus>;
      mockGetTaskStatus.mockResolvedValue({
        taskId,
        userId: 'user123',
        status: 'completed',
        prompt: 'Test prompt',
        requestParams: {},
        resultImage: 'base64-data',
        createdAt: new Date('2024-01-01T00:00:00Z'),
        updatedAt: new Date('2024-01-01T00:01:00Z'),
        completedAt: new Date('2024-01-01T00:01:00Z'),
      });

      const request = new NextRequest(`http://localhost:3000/api/ai/image/status?taskId=${taskId}`);
      const response = await GET(request);
      const data = await response.json();

      // Check all required fields are present
      expect(data).toHaveProperty('taskId');
      expect(data).toHaveProperty('status');
      expect(data).toHaveProperty('createdAt');
      expect(data).toHaveProperty('resultImage');
      expect(data).toHaveProperty('completedAt');
    });
  });
});
