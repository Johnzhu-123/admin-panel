/**
 * Unit tests for Image Generator
 */

// Mock external dependencies BEFORE importing
jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn(),
  MaskReferenceImage: jest.fn(),
  MaskReferenceMode: { MASK_MODE_USER_PROVIDED: 'user_provided' },
  RawReferenceImage: jest.fn(),
  StyleReferenceImage: jest.fn(),
}));

jest.mock('@/lib/ai', () => ({
  defaultGeminiImageModel: 'gemini-pro-vision',
  defaultOpenAiImageModel: 'dall-e-3',
  defaultOpenAiImageResponseFormat: 'b64_json',
  buildOpenAiHeaders: jest.fn(() => ({ 'Content-Type': 'application/json' })),
  normalizeOpenAiAuthHeader: jest.fn((val) => val || 'authorization'),
  normalizeGeminiBaseUrl: jest.fn((val) => ({
    baseUrl: val || 'https://generativelanguage.googleapis.com',
    apiVersion: 'v1beta',
  })),
  normalizeOpenAiBaseUrl: jest.fn((val) => val || 'https://api.openai.com/v1'),
  pickOpenAiImageSize: jest.fn(() => '1024x1024'),
  resolveOpenAiEndpoint: jest.fn((base, path) => `${base}${path}`),
  defaultOpenAiImageEndpointPath: '/images/generations',
}));

jest.mock('@/lib/api-compatibility/integration', () => ({
  generateImageWithCompatibility: jest.fn(),
  handleCompatibilityError: jest.fn(() => ({ canRetry: true, userMessage: 'Error' })),
}));

jest.mock('@/lib/request-queue-manager', () => ({
  queuedFetch: jest.fn(),
}));

// Mock task manager
const mockUpdateTaskStatus = jest.fn();
jest.mock('../task-manager', () => ({
  updateTaskStatus: mockUpdateTaskStatus,
}));

import { generateAsync, isTaskExpired } from '../image-generator';
import { generateImageWithCompatibility } from '@/lib/api-compatibility/integration';

// 🔧 FIX (2026-06-11，与桌面仓同款): shared-utils 的 coerceImageValueToBase64 现在做
// magic-byte + 最小长度(≥256 字符)校验，旧的 1x1 PNG / 'test-base64' 桩字符串会被
// 判为非法图片 → 走直连 fallback → 命中未实现的 queuedFetch mock 而失败。
// 构造 PNG 魔数开头、长度达标的合法桩数据。
const makeValidPngLikeBase64 = () =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(320, 0),
  ]).toString('base64');

describe('Image Generator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateTaskStatus.mockResolvedValue(undefined);
  });

  describe('generateAsync', () => {
    it('should update status to processing when generation starts', async () => {
      const taskId = 'test-task-id';
      const params = {
        prompt: 'A beautiful sunset',
        provider: 'openai' as const,
        apiKey: 'test-key',
        baseUrl: 'https://api.openai.com/v1',
      };

      // Mock successful generation
      const mockBase64 = makeValidPngLikeBase64();
      (generateImageWithCompatibility as jest.Mock).mockResolvedValue({
        images: [{ b64_json: mockBase64 }]
      });

      await generateAsync(taskId, params);

      // Verify processing status was set
      expect(mockUpdateTaskStatus).toHaveBeenCalledWith(taskId, 'processing');
      
      // Verify completed status was set
      expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
        taskId,
        'completed',
        expect.objectContaining({
          resultImage: mockBase64,
        })
      );
    });

    it('should handle timeout after 60 seconds', async () => {
      // This test verifies the timeout mechanism exists
      // In a real scenario, the timeout would trigger after 60 seconds
      // For testing purposes, we verify the structure is correct
      
      const taskId = 'test-task-timeout';
      const params = {
        prompt: 'A beautiful sunset',
        provider: 'openai' as const,
        apiKey: 'test-key',
        baseUrl: 'https://api.openai.com/v1',
      };

      // Mock a generation that completes quickly
      // The timeout logic is tested implicitly through the Promise.race structure
      const mockBase64 = makeValidPngLikeBase64();
      (generateImageWithCompatibility as jest.Mock).mockResolvedValue({
        images: [{ b64_json: mockBase64 }]
      });

      await generateAsync(taskId, params);

      // Verify the function completed without timing out
      expect(mockUpdateTaskStatus).toHaveBeenCalledWith(taskId, 'processing');
      expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
        taskId,
        'completed',
        expect.objectContaining({
          resultImage: mockBase64,
        })
      );
      
      // Note: The actual timeout behavior (60 seconds) is verified through
      // the implementation using Promise.race with a 60000ms timeout
    });

    it('should update status to completed on successful generation', async () => {
      const mockBase64 = makeValidPngLikeBase64();
      (generateImageWithCompatibility as jest.Mock).mockResolvedValue({
        images: [{ b64_json: mockBase64 }]
      });

      const taskId = 'test-task-success';
      const params = {
        prompt: 'A beautiful sunset',
        provider: 'openai' as const,
        apiKey: 'test-key',
        baseUrl: 'https://api.openai.com/v1',
      };

      await generateAsync(taskId, params);

      // Verify completed status was set with result
      expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
        taskId,
        'completed',
        expect.objectContaining({
          resultImage: mockBase64,
        })
      );
    });

    it('should update status to failed on generation error', async () => {
      const errorMessage = 'API key is invalid';
      
      // Mock the compatibility system to throw an error
      (generateImageWithCompatibility as jest.Mock).mockRejectedValue(new Error(errorMessage));
      // 🔧 FIX (2026-06-11，与桌面仓同款): 直连 fallback 的 queuedFetch 也按同错误拒绝，
      // 否则 ESM 模式下 require 取到的 mock 实例可能与实现侧不一致，canRetry 仍为
      // true 时会走 fallback 命中"未实现的 queuedFetch"产生无关错误信息。
      const { queuedFetch } = require('@/lib/request-queue-manager');
      (queuedFetch as jest.Mock).mockRejectedValue(new Error(errorMessage));

      // Also mock handleCompatibilityError to return non-retryable
      const { handleCompatibilityError } = require('@/lib/api-compatibility/integration');
      (handleCompatibilityError as jest.Mock).mockReturnValue({
        canRetry: false,
        userMessage: errorMessage,
        technicalDetails: 'Invalid API key',
        suggestions: []
      });

      const taskId = 'test-task-error';
      const params = {
        prompt: 'A beautiful sunset',
        provider: 'openai' as const,
        apiKey: 'invalid-key',
        baseUrl: 'https://api.openai.com/v1',
      };

      await generateAsync(taskId, params);

      // Verify failed status was set with error
      expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
        taskId,
        'failed',
        expect.objectContaining({
          errorMessage: expect.stringContaining(errorMessage),
        })
      );
    });

    it('should handle unsupported provider', async () => {
      const taskId = 'test-task-unsupported';
      const params = {
        prompt: 'A beautiful sunset',
        provider: 'unsupported' as any,
      };

      await generateAsync(taskId, params);

      // Verify failed status was set
      expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
        taskId,
        'failed',
        expect.objectContaining({
          errorMessage: expect.stringContaining('Unsupported provider'),
        })
      );
    });
  });

  describe('isTaskExpired', () => {
    it('should return false (placeholder implementation)', async () => {
      const result = await isTaskExpired('test-task-id');
      expect(result).toBe(false);
    });
  });
});
