import { NextRequest, NextResponse } from 'next/server';
import { requireAdminSession } from "@/app/api/admin/_auth";

/**
 * Debug endpoint to check environment variables
 * This helps diagnose why async mode might not be working
 *
 * 🔧 FIX (2026-06-11 BUG-DS1): 该路由会回显环境变量信息，必须防护——
 * 要求 query `?key=` 或 header `x-admin-password` 等于 ADMIN_PASSWORD；
 * 未配置 ADMIN_PASSWORD 或不匹配时返回 404（不暴露端点存在性）。
 * 已登录的 admin 会话（cookie）作为兜底凭据继续放行，便于管理面板内调用。
 */
export async function GET(req: NextRequest) {
  const adminPassword = (process.env.ADMIN_PASSWORD || '').trim();
  const providedKey = (
    req.nextUrl.searchParams.get('key') ||
    req.headers.get('x-admin-password') ||
    ''
  ).trim();
  const keyOk = !!adminPassword && providedKey === adminPassword;
  if (!keyOk) {
    const unauthorized = await requireAdminSession();
    if (unauthorized) {
      // 🔧 FIX (2026-06-11 BUG-DS1): 统一 404，避免探测
      return NextResponse.json({ error: 'Not Found' }, { status: 404 });
    }
  }

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
