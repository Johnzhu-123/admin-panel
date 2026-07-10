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
import {
  requireServicePrincipal,
  ServicePrincipalError,
} from "@/lib/auth/service-principal";
import { sql } from "@vercel/postgres";
import { randomUUID } from "crypto";
import { noStoreHeaders } from "@/lib/ai";
import {
  getInternalServiceConfig,
  BUILT_IN_SERVICE_CATEGORIES,
  type BuiltInServiceCategory,
} from "@/lib/built-in-api-service/db";
import { quotaService } from "@/lib/built-in-api-service/quota-service";
import { attachQuotaReleaseToResponse } from "@/lib/built-in-api-service/legacy-quota";
import { fetchPublicHttpUrl } from "@/lib/network/public-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_PROXY_REQUEST_BYTES = 25 * 1024 * 1024;
const STRIPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "x-md2ppt-user-id",
  "x-md2ppt-user-email",
  "x-md2ppt-user-name",
]);

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
  concurrentRequests: number;
}

async function loadAuthorization(userId: string, email?: string): Promise<AuthorizationView | null> {
  try {
    const { rows } = await sql`
      SELECT user_id, email, status, can_use_built_in_services, allowed_services,
             daily_requests, monthly_requests, concurrent_requests
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
      concurrentRequests: row.concurrent_requests ?? 0,
    };
  } catch (error) {
    console.error("[proxy] loadAuthorization 失败:", error);
    throw error;
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

// 🔧 FIX (2026-06-11 BUG-C10): 旧正则 /\/v1\b/ 既不命中 /v1beta、/v1alpha（\b 在
//   字母之间不成立 → 给 Gemini 风格 base 多追加一层 /v1），也不识别 /v4 这类已带
//   版本的 base。改为按"路径段恰为版本段"精确判断：base 任一路径段或 subpath 任一
//   段恰为 v1 / v1beta / v1alpha / v4 等版本段时，不再追加 /v1。
const VERSION_SEGMENT_RE = /^v\d+(?:beta|alpha)?$/i;

function buildUpstreamUrl(baseUrl: string, subpathSegments: string[]): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const path = "/" + subpathSegments.map((s) => encodeURIComponent(s)).join("/");
  let baseSegments: string[];
  try {
    baseSegments = new URL(trimmed).pathname.split("/").filter(Boolean);
  } catch {
    baseSegments = trimmed.split("/").filter(Boolean);
  }
  const hasVersionSegment =
    baseSegments.some((segment) => VERSION_SEGMENT_RE.test(segment)) ||
    subpathSegments.some((segment) => VERSION_SEGMENT_RE.test(segment));
  return hasVersionSegment ? `${trimmed}${path}` : `${trimmed}/v1${path}`;
}

async function handleProxy(
  req: NextRequest,
  context: { params: Promise<{ category: string; subpath: string[] }> }
) {
  const params = await context.params;
  const requestId = randomUUID();
  const startedAt = Date.now();
  let activeReservationId: string | null = null;
  let usageUserId = "unknown";
  let usageServiceId = `built-in-${params?.category || "unknown"}`;

  try {
    const category = params.category;
    if (!isCategory(category)) {
      return json(400, { error: `Invalid category: ${category}` });
    }
    const subpath = Array.isArray(params.subpath) ? params.subpath : [];
    if (!subpath.length) {
      return json(400, { error: "Missing target subpath" });
    }

    const principal = await requireServicePrincipal(req);
    const userId = principal.userId;
    const email = principal.email || "";

    let authorization: AuthorizationView | null;
    try {
      authorization = await loadAuthorization(userId, email);
    } catch {
      return json(503, { error: "授权服务暂不可用" });
    }
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

    let requestBody: ArrayBuffer | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const declaredLength = Number(req.headers.get("content-length") || 0);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_PROXY_REQUEST_BYTES) {
        return json(413, { error: "代理请求体超过 25 MiB 上限" });
      }
      requestBody = await req.arrayBuffer();
      if (requestBody.byteLength > MAX_PROXY_REQUEST_BYTES) {
        return json(413, { error: "代理请求体超过 25 MiB 上限" });
      }
    }

    usageUserId = authorization.userId;
    usageServiceId = `built-in-${category}-${subtask.id}`;
    const quota = await quotaService.acquire({
      userId: authorization.userId,
      serviceId: usageServiceId,
      limits: {
        dailyRequests: authorization.dailyRequests,
        monthlyRequests: authorization.monthlyRequests,
        concurrentRequests: authorization.concurrentRequests,
      },
      reservationTtlMs: 10 * 60 * 1000,
    });
    if (quota.acquired === false) {
      return quota.reason === "database_error"
        ? json(503, { error: "配额服务暂不可用" })
        : json(429, { error: "请求配额已用尽" });
    }
    activeReservationId = quota.reservationId;

    const upstreamUrl = buildUpstreamUrl(subtask.baseUrl, subpath);
    const incomingHeaders = new Headers();
    req.headers.forEach((value, key) => {
      if (!STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) {
        incomingHeaders.set(key, value);
      }
    });
    incomingHeaders.set("Authorization", `Bearer ${subtask.apiKey}`);

    const init: RequestInit = {
      method: req.method,
      headers: incomingHeaders,
      signal: AbortSignal.timeout(120_000),
      body: requestBody,
    };
    const allowPrivateNetwork = process.env.MD2PPT_ALLOW_PRIVATE_API_PROXY === "1";
    let upstreamResp: Response;
    try {
      upstreamResp = await fetchPublicHttpUrl(upstreamUrl, init, {
        description: `${category}/${subtask.id} upstream`,
        allowHttp: allowPrivateNetwork,
        allowPrivateNetwork,
        maxRedirects: 0,
      });
    } catch (error) {
      const released = await quotaService.release(activeReservationId);
      activeReservationId = null;
      if (!released.released) {
        return json(503, { error: "配额服务暂不可用" });
      }
      throw error;
    }
    const responseTime = Date.now() - startedAt;

    void recordUsage({
      requestId,
      userId: authorization.userId,
      serviceId: usageServiceId,
      success: upstreamResp.ok,
      responseTime,
      error: upstreamResp.ok ? undefined : `HTTP ${upstreamResp.status}`,
    });

    const respHeaders = new Headers(upstreamResp.headers);
    respHeaders.delete("content-length");
    respHeaders.delete("transfer-encoding");
    // 🔧 FIX (2026-06-11 BUG-C10): undici 已自动解压响应体，透传 content-encoding
    //   会让客户端对明文再做一次 gzip/br 解压 → 解码失败/乱码。
    respHeaders.delete("content-encoding");
    respHeaders.set("x-builtin-request-id", requestId);
    respHeaders.set("x-builtin-category", category);
    respHeaders.set("x-builtin-subtask", subtask.id);
    respHeaders.set("x-builtin-model-default", subtask.model || "");

    const response = new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: respHeaders,
    });
    if (!activeReservationId) return response;
    const reservationId = activeReservationId;
    activeReservationId = null;
    return await attachQuotaReleaseToResponse(response, reservationId, "proxy");
  } catch (error) {
    if (activeReservationId) {
      const released = await quotaService.release(activeReservationId);
      activeReservationId = null;
      if (!released.released) {
        return json(503, { error: "配额服务暂不可用" });
      }
    }
    if (error instanceof ServicePrincipalError) {
      return json(error.status, { error: error.message });
    }
    const responseTime = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : "代理请求失败";
    void recordUsage({
      requestId,
      userId: usageUserId,
      serviceId: usageServiceId,
      success: false,
      responseTime,
      error: message,
    });
    return json(502, { error: message });
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
