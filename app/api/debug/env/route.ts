import { NextResponse } from 'next/server';
import { requireAdminSession } from "@/app/api/admin/_auth";

/**
 * Debug endpoint to check environment variables
 * This helps diagnose why async mode might not be working
 */
export async function GET() {
  const unauthorized = await requireAdminSession();
  if (unauthorized) return unauthorized;
  const envValue = process.env.ENABLE_ASYNC_IMAGE_GENERATION;
  
  return NextResponse.json({
    ENABLE_ASYNC_IMAGE_GENERATION: {
      value: envValue,
      type: typeof envValue,
      isTrue: envValue === 'true',
      isBooleanTrue: envValue === true,
      isOne: envValue === '1',
      isAsyncEnabled: envValue === 'true' || envValue === true || envValue === '1',
    },
    NODE_ENV: process.env.NODE_ENV,
    VERCEL: process.env.VERCEL,
    VERCEL_ENV: process.env.VERCEL_ENV,
    hasPostgresUrl: !!process.env.POSTGRES_URL,
  });
}
