/**
 * MinerU 内置云端服务 — mineru.net API 转发代理（admin-panel 侧）
 * -----------------------------------------------------------------
 * 链路：md2pptWin 客户端 → md2pptWin /api/material-center/mineru/built-in/proxy
 *      → 本端点 → mineru.net
 *
 * 本端点是 token 注入点：从 env MINERU_BUILT_IN_API_TOKEN 取真实 token，注入
 * Authorization: Bearer ... 后转发到 mineru.net。客户端始终不持有 token。
 *
 * 协议：与 md2pptWin 现有的 `/api/material-center/mineru/proxy` 对齐
 *   - 客户端通过 x-mineru-target-path header 指定 mineru.net 上的 path
 *     （例：/api/v4/file-urls/batch, /api/v4/extract-results/batch/<id>）
 *   - x-mineru-base-url 仅供白名单校验；最终拼出的 URL 由 MINERU_BUILT_IN_BASE_URL 决定
 *   - method / body 原样透传
 *
 * 注意：OSS PUT 不会经过本端点（客户端的 cloudFetch 已对 *.aliyuncs.com 强制
 * 改走原 cloud proxy 的零干扰透传），所以本路由无需处理 OSS 签名签字逻辑。
 */

import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";
import { randomUUID } from "crypto";
import { noStoreHeaders } from "@/lib/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const json = (status: number, payload: Record<string, unknown>) =>
  NextResponse.json(payload, { status, headers: noStoreHeaders() });

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  // 这些自定义控制头不向上游 mineru.net 暴露
  "x-mineru-target-path",
  "x-mineru-base-url",
  "x-mineru-content-type",
]);

interface AuthorizationView {
  userId: string;
  email: string;
  status: string;
  canUseBuiltInServices: boolean;
  allowedServices: string[];
  dailyRequests: number;
  monthlyRequests: number;
}

async function loadAuthorization(userId: string, email?: string): Promise<AuthorizationView | null> {
  try {
    const { rows } = await sql`
      SELECT user_id, email, status, can_use_built_in_services, allowed_services,
             daily_requests, monthly_requests
      FROM authorized_users
      WHERE user_id = ${userId} OR email = ${email || ""}
      LIMIT 1
    `;
    if (!rows.length) return null;
    const row = rows[0];
    return {
      userId: row.user_id,
      email: row.email,
      status: row.status,
      canUseBuiltInServices: row.can_use_built_in_services === true,
      allowedServices: Array.isArray(row.allowed_services) ? row.allowed_services : [],
      dailyRequests: row.daily_requests ?? 0,
      monthlyRequests: row.monthly_requests ?? 0,
    };
  } catch (error) {
    console.error("[mineru/proxy] loadAuthorization 失败:", error);
    return null;
  }
}

async function recordUsage(params: {
  requestId: string;
  userId: string;
  success: boolean;
  responseTime: number;
  error?: string;
}) {
  try {
    await sql`
      INSERT INTO api_usage_records (request_id, user_id, service_id, success, response_time, error)
      VALUES (${params.requestId}, ${params.userId}, ${"built-in-mineru"}, ${params.success}, ${params.responseTime}, ${params.error || null})
      ON CONFLICT (request_id) DO NOTHING
    `;
  } catch (error) {
    console.error("[mineru/proxy] recordUsage 失败:", error);
  }
}

async function checkDailyQuota(userId: string, dailyLimit: number): Promise<boolean> {
  if (!dailyLimit || dailyLimit <= 0) return true;
  try {
    const { rows } = await sql`
      SELECT COUNT(*)::int AS used
      FROM api_usage_records
      WHERE user_id = ${userId}
        AND service_id = ${"built-in-mineru"}
        AND created_at >= CURRENT_DATE
    `;
    const used = rows[0]?.used ?? 0;
    return used < dailyLimit;
  } catch {
    return true;
  }
}

const stripTrailingSlash = (s: string) => s.replace(/\/+$/, "");

async function forward(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const startedAt = Date.now();

  // 1. 校验 target path
  const targetPath = req.headers.get("x-mineru-target-path") || "";
  if (!targetPath || !targetPath.startsWith("/")) {
    return json(400, {
      code: -1,
      msg: 'Missing or invalid header "x-mineru-target-path" (must start with "/")',
    });
  }

  // 2. 校验 token 已配置
  const token = (process.env.MINERU_BUILT_IN_API_TOKEN || "").trim();
  if (!token) {
    return json(503, {
      code: -1,
      msg: "服务端未配置 MINERU_BUILT_IN_API_TOKEN",
    });
  }

  // 3. Clerk 鉴权
  let user;
  try {
    user = await currentUser();
  } catch (err) {
    return json(401, {
      code: -1,
      msg: `Clerk 校验失败: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  if (!user) {
    return json(401, { code: -1, msg: "未登录" });
  }

  const userId = user.id;
  const email =
    user.primaryEmailAddress?.emailAddress ||
    user.emailAddresses?.[0]?.emailAddress ||
    "";

  // 4. 授权校验
  const authorization = await loadAuthorization(userId, email);
  if (!authorization) {
    return json(403, { code: -1, msg: "用户未被加入授权名单" });
  }
  if (authorization.status !== "active") {
    return json(403, { code: -1, msg: `用户状态为 ${authorization.status}` });
  }
  if (!authorization.canUseBuiltInServices) {
    return json(403, { code: -1, msg: "账号未开启内置服务权限" });
  }
  if (
    authorization.allowedServices.length &&
    !authorization.allowedServices.includes("mineru") &&
    !authorization.allowedServices.includes("material-extract") &&
    !authorization.allowedServices.includes("*")
  ) {
    return json(403, { code: -1, msg: "账号未被授权使用 MinerU 服务" });
  }

  // 5. 配额校验
  const quotaOk = await checkDailyQuota(authorization.userId, authorization.dailyRequests);
  if (!quotaOk) {
    void recordUsage({
      requestId,
      userId: authorization.userId,
      success: false,
      responseTime: Date.now() - startedAt,
      error: "QUOTA_EXCEEDED",
    });
    return json(429, { code: -1, msg: "今日配额已用尽" });
  }

  // 6. 构造上游 URL
  const baseUrl = stripTrailingSlash(
    (process.env.MINERU_BUILT_IN_BASE_URL || "").trim() || "https://mineru.net"
  );
  const upstreamUrl = `${baseUrl}${targetPath}`;

  // 7. 构造转发 header：注入 Authorization，剥不应外传的 header
  const fwdHeaders = new Headers();
  req.headers.forEach((value, key) => {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) return;
    if (key.toLowerCase() === "authorization") return; // 客户端可能误传，统一以注入为准
    if (key.toLowerCase() === "cookie") return; // 不向 mineru.net 暴露 Clerk cookie
    if (key.toLowerCase() === "origin") return;
    if (key.toLowerCase() === "referer") return;
    fwdHeaders.set(key, value);
  });
  fwdHeaders.set("Authorization", `Bearer ${token}`);

  // 8. body 透传（GET/HEAD 无 body）
  const method = req.method.toUpperCase();
  let body: BodyInit | undefined = undefined;
  if (method !== "GET" && method !== "HEAD") {
    const ab = await req.arrayBuffer();
    if (ab.byteLength > 0) body = ab;
  }

  // 9. 转发
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method,
      headers: fwdHeaders,
      body,
      redirect: "follow",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void recordUsage({
      requestId,
      userId: authorization.userId,
      success: false,
      responseTime: Date.now() - startedAt,
      error: `fetch_failed: ${message}`,
    });
    return json(502, {
      code: -1,
      msg: `mineru.net 转发失败: ${message}`,
    });
  }

  const responseTime = Date.now() - startedAt;
  void recordUsage({
    requestId,
    userId: authorization.userId,
    success: upstream.ok,
    responseTime,
    error: upstream.ok ? undefined : `HTTP ${upstream.status}`,
  });

  // 10. 响应透传
  const resHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    const lk = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lk)) return;
    if (lk === "content-encoding") return;
    resHeaders.set(key, value);
  });
  resHeaders.set("x-builtin-request-id", requestId);

  return new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: resHeaders,
  });
}

export async function GET(req: NextRequest) {
  return forward(req);
}
export async function POST(req: NextRequest) {
  return forward(req);
}
export async function PUT(req: NextRequest) {
  return forward(req);
}
export async function DELETE(req: NextRequest) {
  return forward(req);
}
export async function PATCH(req: NextRequest) {
  return forward(req);
}
export async function OPTIONS() {
  return new NextResponse(null, { status: 200 });
}
