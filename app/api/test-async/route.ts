import { NextResponse } from 'next/server';
import { requireAdminSession } from '@/app/api/admin/_auth';
import { createTask } from '@/lib/async-image-generation/task-manager';

/**
 * Test endpoint to verify async task creation works
 * This helps diagnose database issues
 */
export async function POST(req: Request) {
  const unauthorized = await requireAdminSession();
  if (unauthorized) return unauthorized;

  try {
    const body = await req.json();
    const userId = body.userId || 'test-user';
    const prompt = body.prompt || 'Test prompt';
    
    console.log('[TestAsync] Attempting to create task...');
    console.log('[TestAsync] Database env check:', {
      hasPostgresUrl: !!process.env.POSTGRES_URL,
      hasPostgresPrismaUrl: !!process.env.POSTGRES_PRISMA_URL,
      hasPostgresUrlNonPooling: !!process.env.POSTGRES_URL_NON_POOLING,
    });
    
    const taskRecord = await createTask({
      userId,
      prompt,
      requestParams: body,
    });
    
    console.log('[TestAsync] Task created successfully:', taskRecord.taskId);
    
    return NextResponse.json({
      success: true,
      taskId: taskRecord.taskId,
      message: 'Task created successfully',
    });
  } catch (error) {
    console.error('[TestAsync] Failed to create task:', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      errorType: error?.constructor?.name,
    });
    
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    }, { status: 500 });
  }
}
