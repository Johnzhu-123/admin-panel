/**
 * Cleanup utilities for async image generation tasks
 * Handles deletion of expired tasks to maintain database performance
 */

import { sql } from '@vercel/postgres';

/**
 * Clean up expired tasks (older than specified date)
 * 
 * @param olderThan - Delete tasks completed before this date
 * @returns Number of tasks deleted
 * @throws Error if database operation fails
 */
export async function cleanupExpiredTasks(olderThan: Date): Promise<number> {
  try {
    console.log('[Cleanup] Cleaning up expired tasks older than:', olderThan.toISOString());

    const result = await sql`
      DELETE FROM image_generation_tasks
      WHERE completed_at < ${olderThan.toISOString()}
      AND status IN ('completed', 'failed')
    `;

    const deletedCount = result.rowCount || 0;
    console.log('[Cleanup] Cleaned up tasks:', deletedCount);

    return deletedCount;
  } catch (error) {
    console.error('[Cleanup] Failed to cleanup expired tasks:', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      olderThan: olderThan.toISOString()
    });
    throw new Error(`Failed to cleanup expired tasks: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Clean up tasks older than 24 hours
 * Convenience function for common cleanup scenario
 * 
 * @returns Number of tasks deleted
 */
export async function cleanupOldTasks(): Promise<number> {
  const cutoffDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return cleanupExpiredTasks(cutoffDate);
}
