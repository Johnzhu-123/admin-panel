/**
 * Image Generation Status API
 * GET /api/ai/image/status?taskId=xxx
 * 
 * Query the status of an async image generation task
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTaskStatus } from '@/lib/async-image-generation/task-manager';
import { generateAsync } from '@/lib/async-image-generation/image-generator';
import type { GenerationParams } from '@/lib/async-image-generation/image-generator';

const normalizeRemoteBase = (base?: string) =>
  (base || "").trim().replace(/\/+$/, "");

const getRemoteBuiltInBase = () => {
  const raw =
    process.env.BUILT_IN_SERVICE_SERVER_URL ||
    process.env.NEXT_PUBLIC_BUILT_IN_SERVICE_SERVER_URL ||
    "";
  const normalized = normalizeRemoteBase(raw);
  if (!normalized) return "";
  if (process.env.ELECTRON_DESKTOP !== "1") return "";
  return normalized;
};

/**
 * API Response for task status query
 */
interface TaskStatusResponse {
  taskId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  resultImage?: string;
  errorMessage?: string;
  createdAt: string;
  completedAt?: string;
}

/**
 * Error response structure
 */
interface ErrorResponse {
  error: string;
  details?: string;
}

/**
 * GET handler for querying task status
 * 
 * Query parameters:
 * - taskId: The unique task identifier (required)
 * 
 * Response:
 * - 200: Task found, returns status and data
 * - 400: Missing or invalid taskId parameter
 * - 404: Task not found
 * - 500: Internal server error
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const startTime = Date.now();
  
  try {
    const remoteBase = getRemoteBuiltInBase();
    if (remoteBase) {
      const incoming = new URL(request.url);
      const targetUrl = `${remoteBase}${incoming.pathname}${incoming.search}`;
      const response = await fetch(targetUrl, { cache: "no-store" });
      const text = await response.text();
      try {
        const data = text ? JSON.parse(text) : {};
        return NextResponse.json(data, { status: response.status });
      } catch {
        return new NextResponse(text, { status: response.status });
      }
    }

    // Extract taskId from query parameters
    const { searchParams } = new URL(request.url);
    const taskId = searchParams.get('taskId');

    // Validate taskId parameter
    if (!taskId) {
      console.warn('[StatusAPI] Missing taskId parameter');
      const errorResponse: ErrorResponse = {
        error: 'Missing required parameter: taskId',
        details: 'Please provide a taskId query parameter',
      };
      return NextResponse.json(errorResponse, { status: 400 });
    }

    // Validate taskId format (should be a UUID)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(taskId)) {
      console.warn('[StatusAPI] Invalid taskId format:', taskId);
      const errorResponse: ErrorResponse = {
        error: 'Invalid taskId format',
        details: 'taskId must be a valid UUID',
      };
      return NextResponse.json(errorResponse, { status: 400 });
    }

    console.log('[StatusAPI] Querying task status:', {
      taskId,
      timestamp: new Date().toISOString(),
    });

    // Query task status from database
    const taskRecord = await getTaskStatus(taskId);

    // Handle task not found
    if (!taskRecord) {
      console.log('[StatusAPI] Task not found:', taskId);
      const errorResponse: ErrorResponse = {
        error: 'Task not found',
        details: `No task found with ID: ${taskId}`,
      };
      return NextResponse.json(errorResponse, { status: 404 });
    }

    // 🔧 WORKAROUND: Trigger background processing if task is still pending
    // This is necessary because Vercel serverless functions don't support true background tasks
    if (taskRecord.status === 'pending') {
      console.log('[StatusAPI] Task is pending, triggering background processing:', taskId);
      
      // Extract generation params from request_params
      // 🔧 FIX (2026-06-11 类型门禁): requestParams 建任务时即由 image route 持久化
      // 原始生成请求 body（含 prompt/provider），DB 层类型宽为 Record<string, any>，
      // 此处收窄回 GenerationParams（仅类型层断言，运行时行为不变）。
      const generationParams = taskRecord.requestParams as GenerationParams;
      
      // Trigger async generation (fire and forget)
      generateAsync(taskId, generationParams).catch((error) => {
        console.error('[StatusAPI] Background generation error:', error);
      });
      
      console.log('[StatusAPI] Background processing triggered for task:', taskId);
    }

    // Build response based on task status
    const response: TaskStatusResponse = {
      taskId: taskRecord.taskId,
      status: taskRecord.status,
      createdAt: taskRecord.createdAt.toISOString(),
    };

    // Include completedAt if task is completed or failed
    if (taskRecord.completedAt) {
      response.completedAt = taskRecord.completedAt.toISOString();
    }

    // Include result image if task is completed
    if (taskRecord.status === 'completed' && taskRecord.resultImage) {
      response.resultImage = taskRecord.resultImage;
      console.log('[StatusAPI] Task completed, returning result:', {
        taskId,
        imageLength: taskRecord.resultImage.length,
      });
    }

    // Include error message if task failed
    if (taskRecord.status === 'failed' && taskRecord.errorMessage) {
      response.errorMessage = taskRecord.errorMessage;
      console.log('[StatusAPI] Task failed, returning error:', {
        taskId,
        error: taskRecord.errorMessage,
      });
    }

    // Log response time
    const duration = Date.now() - startTime;
    console.log('[StatusAPI] Request completed:', {
      taskId,
      status: taskRecord.status,
      duration: `${duration}ms`,
    });

    // Return successful response
    return NextResponse.json(response, { status: 200 });

  } catch (error) {
    // Handle unexpected errors
    const duration = Date.now() - startTime;
    console.error('[StatusAPI] Unexpected error:', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      duration: `${duration}ms`,
      timestamp: new Date().toISOString(),
    });

    const errorResponse: ErrorResponse = {
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' 
        ? (error instanceof Error ? error.message : 'Unknown error')
        : undefined,
    };

    return NextResponse.json(errorResponse, { status: 500 });
  }
}
