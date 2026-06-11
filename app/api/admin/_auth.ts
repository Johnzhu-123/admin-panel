import { NextResponse } from "next/server";
import { cookies } from "next/headers";

// 🔧 FIX (2026-06-11 类型门禁): activeSessions 原先定义在 auth/route.ts 并 export，
// 但 Next.js 路由文件只允许导出 handler/路由配置（.next/types 校验报
// "Property 'activeSessions' is incompatible with index signature"）。
// 会话存储移到本非路由模块统一持有，auth/route.ts 反向引用。
// Server-side session store (in-memory, resets on restart)
export const activeSessions = new Map<
  string,
  { createdAt: number; expiresAt: number }
>();

export async function requireAdminSession() {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("admin-session");

  if (!sessionCookie?.value) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const session = activeSessions.get(sessionCookie.value);
  if (!session || Date.now() > session.expiresAt) {
    if (session) activeSessions.delete(sessionCookie.value);
    cookieStore.delete("admin-session");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}

