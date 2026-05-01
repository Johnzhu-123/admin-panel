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
  try {
    console.log('[InitAsyncTable] Starting async table initialization...');

    // Create table if it doesn't exist
    console.log('[InitAsyncTable] Creating image_generation_tasks table...');
    await sql`
      CREATE TABLE IF NOT EXISTS image_generation_tasks (
        task_id VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        prompt TEXT NOT NULL,
        request_params JSONB,
        result_image TEXT,
        error_message TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP
      )
    `;
    console.log('[InitAsyncTable] Table created or already exists');

    // Create indexes for better performance
    console.log('[InitAsyncTable] Creating indexes...');
    await sql`CREATE INDEX IF NOT EXISTS idx_task_user_id ON image_generation_tasks(user_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_task_status ON image_generation_tasks(status)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_task_created_at ON image_generation_tasks(created_at)`;
    console.log('[InitAsyncTable] Indexes created');

    // Verify table exists
    console.log('[InitAsyncTable] Verifying table...');
    const { rows } = await sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name = 'image_generation_tasks'
    `;
    console.log('[InitAsyncTable] Verification result:', rows);

    if (rows.length === 0) {
      throw new Error('Table was not created successfully');
    }

    // Get table structure
    const { rows: columns } = await sql`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'image_generation_tasks'
      ORDER BY ordinal_position
    `;
    console.log('[InitAsyncTable] Table structure:', columns);

    // Get row count
    const { rows: countRows } = await sql`SELECT COUNT(*) as count FROM image_generation_tasks`;
    const rowCount = countRows[0]?.count || 0;

    return NextResponse.json({
      success: true,
      message: 'Async image generation table initialized successfully',
      details: {
        tableCreated: true,
        tableExists: rows.length > 0,
        rowCount: parseInt(rowCount as string),
        columns: columns.map(c => ({ name: c.column_name, type: c.data_type })),
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('[InitAsyncTable] Error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined
    }, { status: 500 });
  }
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
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}
