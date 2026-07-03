/**
 * Task Manager for Async Image Generation
 * Handles creation, updating, and querying of image generation tasks
 */

import { sql } from '@vercel/postgres';
import { randomUUID } from 'crypto';

/**
 * Task status enum
 */
export type TaskStatus = 'pending' | 'processing' | 'completed' | 'failed';

/**
 * Parameters for creating a new task
 */
export interface CreateTaskParams {
  userId: string;
  prompt: string;
  requestParams: Record<string, any>;
}

/**
 * Task record structure
 */
export interface TaskRecord {
  taskId: string;
  userId: string;
  status: TaskStatus;
  prompt: string;
  requestParams: Record<string, any>;
  resultImage?: string;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

/**
 * Data for updating task status
 */
export interface UpdateData {
  resultImage?: string;
  errorMessage?: string;
}

/**
 * Task Manager interface
 */
export interface TaskManager {
  createTask(params: CreateTaskParams): Promise<TaskRecord>;
  updateTaskStatus(taskId: string, status: TaskStatus, data?: UpdateData): Promise<void>;
  claimPendingTask(taskId: string): Promise<{ requestParams: Record<string, any> } | null>;
  getTaskStatus(taskId: string): Promise<TaskRecord | null>;
  cleanupExpiredTasks(olderThan: Date): Promise<number>;
}

/**
 * Create a new image generation task
 * 
 * @param params - Task creation parameters
 * @returns Created task record
 * @throws Error if database operation fails
 */
export async function createTask(params: CreateTaskParams): Promise<TaskRecord> {
  const { userId, prompt, requestParams } = params;

  // Validate required parameters
  if (!userId || !prompt) {
    const error = new Error('Missing required parameters: userId and prompt are required');
    console.error('[TaskManager] Validation error:', error.message);
    throw error;
  }

  // Generate unique task ID
  const taskId = randomUUID();
  const now = new Date();

  try {
    console.log('[TaskManager] Creating task:', {
      taskId,
      userId,
      prompt: prompt.substring(0, 50) + '...',
      timestamp: now.toISOString()
    });

    // Insert task record into database
    await sql`
      INSERT INTO image_generation_tasks (
        task_id,
        user_id,
        status,
        prompt,
        request_params,
        created_at,
        updated_at
      ) VALUES (
        ${taskId},
        ${userId},
        ${'pending'},
        ${prompt},
        ${JSON.stringify(requestParams)},
        ${now.toISOString()},
        ${now.toISOString()}
      )
    `;

    console.log('[TaskManager] Task created successfully:', taskId);

    // Return task record
    const taskRecord: TaskRecord = {
      taskId,
      userId,
      status: 'pending',
      prompt,
      requestParams,
      createdAt: now,
      updatedAt: now
    };

    return taskRecord;
  } catch (error) {
    console.error('[TaskManager] Failed to create task:', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      taskId,
      userId
    });
    throw new Error(`Failed to create task: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Update task status and related fields
 * 
 * @param taskId - Task ID to update
 * @param status - New status
 * @param data - Optional data to update (resultImage, errorMessage)
 * @throws Error if database operation fails
 */
export async function updateTaskStatus(
  taskId: string,
  status: TaskStatus,
  data?: UpdateData
): Promise<void> {
  if (!taskId) {
    const error = new Error('Missing required parameter: taskId');
    console.error('[TaskManager] Validation error:', error.message);
    throw error;
  }

  const now = new Date();
  const completedAt = (status === 'completed' || status === 'failed') ? now : null;

  try {
    console.log('[TaskManager] Updating task status:', {
      taskId,
      status,
      hasResultImage: !!data?.resultImage,
      hasErrorMessage: !!data?.errorMessage,
      timestamp: now.toISOString()
    });

    // Build update query based on provided data
    if (data?.resultImage) {
      await sql`
        UPDATE image_generation_tasks
        SET 
          status = ${status},
          result_image = ${data.resultImage},
          updated_at = ${now.toISOString()},
          completed_at = ${completedAt ? completedAt.toISOString() : null}
        WHERE task_id = ${taskId}
      `;
    } else if (data?.errorMessage) {
      await sql`
        UPDATE image_generation_tasks
        SET 
          status = ${status},
          error_message = ${data.errorMessage},
          updated_at = ${now.toISOString()},
          completed_at = ${completedAt ? completedAt.toISOString() : null}
        WHERE task_id = ${taskId}
      `;
    } else {
      await sql`
        UPDATE image_generation_tasks
        SET 
          status = ${status},
          updated_at = ${now.toISOString()},
          completed_at = ${completedAt ? completedAt.toISOString() : null}
        WHERE task_id = ${taskId}
      `;
    }

    console.log('[TaskManager] Task status updated successfully:', taskId);
  } catch (error) {
    console.error('[TaskManager] Failed to update task status:', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      taskId,
      status
    });
    throw new Error(`Failed to update task status: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Atomically claim a pending task for processing.
 * Only one caller can successfully claim the same task.
 *
 * @param taskId - Task ID to claim
 * @returns requestParams when claim succeeds, otherwise null
 */
export async function claimPendingTask(
  taskId: string
): Promise<{ requestParams: Record<string, any> } | null> {
  if (!taskId) {
    const error = new Error('Missing required parameter: taskId');
    console.error('[TaskManager] Validation error:', error.message);
    throw error;
  }

  const now = new Date();

  try {
    const { rows } = await sql`
      UPDATE image_generation_tasks
      SET
        status = ${'processing'},
        updated_at = ${now.toISOString()}
      WHERE task_id = ${taskId}
        AND status = ${'pending'}
      RETURNING request_params
    `;

    if (!rows.length) {
      return null;
    }

    const rawParams = rows[0]?.request_params;
    let requestParams: Record<string, any> = {};
    try {
      requestParams =
        typeof rawParams === 'string' ? JSON.parse(rawParams) : (rawParams || {});
    } catch (parseError) {
      console.warn('[TaskManager] Failed to parse claimed request_params:', parseError);
      requestParams = {};
    }

    return { requestParams };
  } catch (error) {
    console.error('[TaskManager] Failed to claim pending task:', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      taskId,
    });
    throw new Error(
      `Failed to claim pending task: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Get task status by task ID
 * 
 * @param taskId - Task ID to query
 * @returns Task record or null if not found
 * @throws Error if database operation fails
 */
export async function getTaskStatus(taskId: string): Promise<TaskRecord | null> {
  if (!taskId) {
    const error = new Error('Missing required parameter: taskId');
    console.error('[TaskManager] Validation error:', error.message);
    throw error;
  }

  try {
    console.log('[TaskManager] Querying task status:', taskId);

    const { rows } = await sql`
      SELECT 
        task_id,
        user_id,
        status,
        prompt,
        request_params,
        result_image,
        error_message,
        created_at,
        updated_at,
        completed_at
      FROM image_generation_tasks
      WHERE task_id = ${taskId}
    `;

    if (rows.length === 0) {
      console.log('[TaskManager] Task not found:', taskId);
      return null;
    }

    const row = rows[0];

    // Parse request_params from JSONB
    let requestParams: Record<string, any> = {};
    try {
      requestParams = typeof row.request_params === 'string'
        ? JSON.parse(row.request_params)
        : row.request_params || {};
    } catch (parseError) {
      console.warn('[TaskManager] Failed to parse request_params:', parseError);
      requestParams = {};
    }

    const taskRecord: TaskRecord = {
      taskId: row.task_id,
      userId: row.user_id,
      status: row.status as TaskStatus,
      prompt: row.prompt,
      requestParams,
      resultImage: row.result_image || undefined,
      errorMessage: row.error_message || undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined
    };

    console.log('[TaskManager] Task found:', {
      taskId: taskRecord.taskId,
      status: taskRecord.status,
      hasResult: !!taskRecord.resultImage,
      hasError: !!taskRecord.errorMessage
    });

    return taskRecord;
  } catch (error) {
    console.error('[TaskManager] Failed to get task status:', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      taskId
    });
    throw new Error(`Failed to get task status: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Clean up expired tasks (older than specified date)
 * 
 * @param olderThan - Delete tasks completed before this date
 * @returns Number of tasks deleted
 * @throws Error if database operation fails
 */
export async function cleanupExpiredTasks(olderThan: Date): Promise<number> {
  try {
    console.log('[TaskManager] Cleaning up expired tasks older than:', olderThan.toISOString());

    const result = await sql`
      DELETE FROM image_generation_tasks
      WHERE completed_at < ${olderThan.toISOString()}
      AND status IN ('completed', 'failed')
    `;

    const deletedCount = result.rowCount || 0;
    console.log('[TaskManager] Cleaned up tasks:', deletedCount);

    return deletedCount;
  } catch (error) {
    console.error('[TaskManager] Failed to cleanup expired tasks:', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      olderThan: olderThan.toISOString()
    });
    throw new Error(`Failed to cleanup expired tasks: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Check if database is available and properly configured
 * 
 * @returns Promise<boolean> - true if database is accessible, false otherwise
 */
export async function isDatabaseAvailable(): Promise<boolean> {
  // First check if POSTGRES_URL is configured
  if (!process.env.POSTGRES_URL) {
    console.log('[TaskManager] Database not available: POSTGRES_URL not configured');
    return false;
  }

  try {
    // Try a simple query to verify connection
    const result = await sql`SELECT 1 as test`;
    console.log('[TaskManager] Database health check passed:', {
      connected: true,
      timestamp: new Date().toISOString()
    });
    return true;
  } catch (error) {
    console.error('[TaskManager] Database health check failed:', {
      error: error instanceof Error ? error.message : 'Unknown error',
      hasPostgresUrl: !!process.env.POSTGRES_URL,
      timestamp: new Date().toISOString()
    });
    return false;
  }
}

/**
 * Ensure the image_generation_tasks table exists
 * Call this on first request to initialize the database schema
 * 
 * @returns Promise<boolean> - true if table exists or was created, false on error
 */
export async function ensureTableExists(): Promise<boolean> {
  if (!process.env.POSTGRES_URL) {
    console.log('[TaskManager] Cannot ensure table: POSTGRES_URL not configured');
    return false;
  }

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS image_generation_tasks (
        task_id UUID PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        prompt TEXT NOT NULL,
        request_params JSONB,
        result_image TEXT,
        error_message TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        completed_at TIMESTAMP WITH TIME ZONE
      )
    `;

    // Create index on user_id for faster queries
    await sql`
      CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON image_generation_tasks(user_id)
    `;

    // Create index on status for cleanup queries
    await sql`
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON image_generation_tasks(status)
    `;

    console.log('[TaskManager] Table and indexes ensured');
    return true;
  } catch (error) {
    console.error('[TaskManager] Failed to ensure table exists:', {
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    return false;
  }
}

/**
 * Default task manager implementation
 */
export const taskManager: TaskManager = {
  createTask,
  updateTaskStatus,
  claimPendingTask,
  getTaskStatus,
  cleanupExpiredTasks
};
