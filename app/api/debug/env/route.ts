import { NextRequest, NextResponse } from 'next/server';
import { requireAdminSession } from "@/app/api/admin/_auth";

/**
 * Debug endpoint to check environment variables
 * This helps diagnose why async mode might not be working
 *
 * This endpoint exposes only non-secret diagnostics and requires a DB-backed
 * admin session. Passwords are never accepted through URLs or headers.
 */
export async function GET(req: NextRequest) {
  void req;
  const unauthorized = await requireAdminSession();
  if (unauthorized) return unauthorized;

  const envValue = process.env.ENABLE_ASYNC_IMAGE_GENERATION;

  // 🔧 FIX (2026-06-11 BUG-DS1): 修复存量 TS2367 —— envValue 是 string|undefined，
  // 旧代码 `envValue === true` 拿 string 和 boolean 比较恒为 false。env 变量只可能
  // 是字符串，按语义改为 'true'/'1' 归一化判断。
  const isAsyncEnabled = envValue === 'true' || envValue === '1';

  return NextResponse.json({
    ENABLE_ASYNC_IMAGE_GENERATION: {
      value: envValue,
      type: typeof envValue,
      isTrue: envValue === 'true',
      isOne: envValue === '1',
      isAsyncEnabled,
    },
    NODE_ENV: process.env.NODE_ENV,
    VERCEL: process.env.VERCEL,
    VERCEL_ENV: process.env.VERCEL_ENV,
    hasPostgresUrl: !!process.env.POSTGRES_URL,
  });
}
