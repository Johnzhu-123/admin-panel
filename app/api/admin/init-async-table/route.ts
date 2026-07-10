import { requireAdminSession } from "@/app/api/admin/_auth";
/**
 * Initialize Async Image Generation Table
 * Creates the image_generation_tasks table for async mode
 */

import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

export async function POST() {
  const unauthorized = await requireAdminSession();
  if (unauthorized) return unauthorized;
  return NextResponse.json(
    {
      success: false,
      error: 'Database DDL is not available over HTTP',
      action: 'Run the approved database migration scripts from a trusted deployment shell.',
    },
    { status: 410 }
  );
}

export async function GET() {
  const unauthorized = await requireAdminSession();
  if (unauthorized) return unauthorized;
  try {
    // Check if table exists
    const { rows } = await sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name = 'image_generation_tasks'
    `;

    const tableExists = rows.length > 0;

    if (tableExists) {
      // Get row count
      const { rows: countRows } = await sql`SELECT COUNT(*) as count FROM image_generation_tasks`;
      const rowCount = countRows[0]?.count || 0;

      // Get recent tasks
      const { rows: recentTasks } = await sql`
        SELECT task_id, user_id, status, created_at
        FROM image_generation_tasks
        ORDER BY created_at DESC
        LIMIT 5
      `;

      return NextResponse.json({
        tableExists: true,
        rowCount: parseInt(rowCount as string),
        recentTasks: recentTasks.map(task => ({
          taskId: task.task_id,
          userId: task.user_id,
          status: task.status,
          createdAt: task.created_at
        }))
      });
    } else {
      return NextResponse.json({
        tableExists: false,
        message: 'Table does not exist. Use POST method to create it.'
      });
    }
  } catch (error) {
    console.error('[InitAsyncTable] Error checking table:', error);
    return NextResponse.json({
      error: 'Async table status check failed'
    }, { status: 500 });
  }
}
