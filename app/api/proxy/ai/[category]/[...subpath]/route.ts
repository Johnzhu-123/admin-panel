/**
 * AI 代理路由（catch-all）
 *
 * 客户端调用规则：
 *   POST /api/proxy/ai/text/chat/completions?subtask=plan
 *   POST /api/proxy/ai/image/images/generations?subtask=generation
 *   POST /api/proxy/ai/image/chat/completions?subtask=understanding   ← 同类不同 subtask 用不同 model/baseUrl
 *   POST /api/proxy/ai/tts/audio/speech                                ← 不传 subtask 走该 category 的 default
 *   POST /api/proxy/ai/multimodal/chat/completions
 *   POST /api/proxy/ai/video/video/generations?subtask=text2video
 *
 * 行为：
 * 1. Clerk 验证用户身份（currentUser）
 * 2. 在 authorized_users 表查授权状态 + can_use_built_in_services
 * 3. 根据 ?subtask=xxx（缺省取 category.defaultSubtaskId）解析 subtask 配置
 * 4. 注入服务端配置的 baseUrl + apiKey
 * 5. 转发请求（支持流式）
 * 6. 异步记录 api_usage_records，service_id = built-in-{category}-{subtaskId}
 *
 * 注意：apiKey 永不出服务端。
 */

import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";
import { randomUUID } from "crypto";
import { noStoreHeaders } from "@/lib/ai";
import {
  getInternalServiceConfig,
  BUILT_IN_SERVICE_CATEGORIES,
  type BuiltInServiceCategory,
} from "@/lib/built-in-api-service/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const isCategory = (value: string): value is BuiltInServiceCategory =>
  (BUILT_IN_SERVICE_CATEGORIES as readonly string[]).includes(value);

const json = (status: number, payload: Record<string, unknown>) =>
  NextResponse.json(payload, { status, headers: noStoreHeaders() });

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
    console.error("[proxy] loadAuthorization 失败:", error);
    return null;
  }
}

async function recordUsage(params: {
  requestId: string;
  userId: string;
  serviceId: string;
  success: boolean;
  responseTime: number;
  error?: string;
}) {
  try {
    await sql`
      INSERT INTO api_usage_records (request_id, user_id, service_id, success, response_time, error)
      VALUES (${params.requestId}, ${params.userId}, ${params.serviceId}, ${params.success}, ${params.responseTime}, ${params.error || null})
      ON CONFLICT (request_id) DO NOTHING
    `;
  } catch (error) {
    console.error("[proxy] recordUsage 失败:", error);
  }
}

async function checkDailyQuota(userId: string, dailyLimit: number): Promise<boolean> {
  if (!dailyLimit || dailyLimit <= 0) return true;
  try {
    const { rows } = await sql`
      SELECT COUNT(*)::int AS used
      FROM api_usage_records
      WHERE user_id = ${userId}
        AND created_at >= CURRENT_DATE
    `;
    const used = rows[0]?.used ?? 0;
    return used < dailyLimit;
  } catch {
    return true;
  }
}

function buildUpstreamUrl(baseUrl: string, subpathSegments: string[]): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const path = "/" + subpathSegments.map((s) => encodeURIComponent(s)).join("/");
  return /\/v1\b/i.test(trimmed) || /\/v1\b/i.test(path)
    ? `${trimmed}${path}`
    : `${trimmed}/v1${path}`;
}

async function handleProxy(
  req: NextRequest,
  context: { params: Promise<{ category: string; subpath: string[] }> }
) {
  const params = await context.params;
  const requestId = randomUUID();
  const startedAt = Date.now();

  try {
    const category = params.category;
    if (!isCategory(category)) {
      return json(400, { error: `Invalid category: ${category}` });
    }
    const subpath = Array.isArray(params.subpath) ? params.subpath : [];
    if (!subpath.length) {
      return json(400, { error: "Missing target subpath" });
    }

    const user = await currentUser();
    if (!user) {
      return json(401, { error: "未登录" });
    }
    const userId = user.id;
    const email =
      user.primaryEmailAddress?.emailAddress ||
      user.emailAddresses?.[0]?.emailAddress ||
      "";

    const authorization = await loadAuthorization(userId, email);
    if (!authorization) {
      return json(403, { error: "用户未被授权使用内置服务" });
    }
    if (authorization.status !== "active") {
      return json(403, { error: `用户状态为 ${authorization.status}，无法使用` });
    }
    if (!authorization.canUseBuiltInServices) {
      return json(403, { error: "该账号未开启内置服务权限" });
    }
    if (
      authorization.allowedServices.length &&
      !authorization.allowedServices.includes(category) &&
      !authorization.allowedServices.includes("*")
    ) {
      return json(403, { error: `账号未授权 ${category} 服务` });
    }
    const quotaOk = await checkDailyQuota(authorization.userId, authorization.dailyRequests);
    if (!quotaOk) {
      return json(429, { error: "今日配额已用尽" });
    }

    const catalogEntry = await getInternalServiceConfig(category, req.nextUrl.searchParams.get("subtask") || undefined);
    if (!catalogEntry) {
      return json(503, { error: `${category} 服务未配置` });
    }
    const { subtask } = catalogEntry;
    if (!subtask.isEnabled) {
      return json(503, { error: `${category}/${subtask.id} 子任务未启用` });
    }
    if (!subtask.baseUrl || !subtask.apiKey) {
      return json(503, { error: `${category}/${subtask.id} 服务未配置（baseUrl/apiKey 缺失）` });
    }

    const upstreamUrl = buildUpstreamUrl(subtask.baseUrl, subpath);
    const incomingHeaders = new Headers(req.headers);
    incomingHeaders.delete("authorization");
    incomingHeaders.delete("cookie");
    incomingHeaders.delete("host");
    incomingHeaders.delete("content-length");
    incomingHeaders.set("Authorization", `Bearer ${subtask.apiKey}`);

    const init: RequestInit = {
      method: req.method,
      headers: incomingHeaders,
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      init.body = req.body as unknown as BodyInit;
      // @ts-expect-error duplex required for streaming bodies under Node fetch
      init.duplex = "half";
    }

    const upstreamResp = await fetch(upstreamUrl, init);
    const responseTime = Date.now() - startedAt;

    void recordUsage({
      requestId,
      userId: authorization.userId,
      serviceId: `built-in-${category}-${subtask.id}`,
      success: upstreamResp.ok,
      responseTime,
      error: upstreamResp.ok ? undefined : `HTTP ${upstreamResp.status}`,
    });

    const respHeaders = new Headers(upstreamResp.headers);
    respHeaders.delete("content-length");
    respHeaders.delete("transfer-encoding");
    respHeaders.set("x-builtin-request-id", requestId);
    respHeaders.set("x-builtin-category", category);
    respHeaders.set("x-builtin-subtask", subtask.id);
    respHeaders.set("x-builtin-model-default", subtask.model || "");

    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: respHeaders,
    });
  } catch (error) {
    const responseTime = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : "代理请求失败";
    void recordUsage({
      requestId,
      userId: "unknown",
      serviceId: `built-in-${params?.category || "unknown"}`,
      success: false,
      responseTime,
      error: message,
    });
    return json(500, { error: message });
  }
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ category: string; subpath: string[] }> }
) {
  return handleProxy(req, context);
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ category: string; subpath: string[] }> }
) {
  return handleProxy(req, context);
}

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ category: string; subpath: string[] }> }
) {
  return handleProxy(req, context);
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ category: string; subpath: string[] }> }
) {
  return handleProxy(req, context);
}
