import { requireAdminSession } from "@/app/api/admin/_auth";
/**
 * Clear Service Cache API
 * Clears all caches in the built-in API service
 */

import { NextResponse } from 'next/server';
import { getBuiltInAPIService } from '@/lib/built-in-api-service';

export async function POST(req: Request) {
  const unauthorized = await requireAdminSession();
  if (unauthorized) return unauthorized;
  try {
    console.log('[ClearCache] Clearing all service caches...');

    const builtInService = getBuiltInAPIService();
    await builtInService.initialize();

    // Clear all caches
    builtInService.clearCaches();

    console.log('[ClearCache] All caches cleared successfully');

    return NextResponse.json({
      success: true,
      message: 'All caches cleared successfully',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('[ClearCache] Error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}
