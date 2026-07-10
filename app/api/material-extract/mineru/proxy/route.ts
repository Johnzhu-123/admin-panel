/**
 * MinerU 内置云端服务 — mineru.net API 转发代理（admin-panel 侧）
 * -----------------------------------------------------------------
 * 链路：md2pptWin 客户端 → md2pptWin /api/material-center/mineru/built-in/proxy
 *      → 本端点 → mineru.net
 *
 * 本端点是 token 注入点：从 admin-panel 系统设置读取真实 token，注入
 * Authorization: Bearer ... 后转发到 MinerU 上游。客户端始终不持有 token。
 *
 * 协议：与 md2pptWin 现有的 `/api/material-center/mineru/proxy` 对齐
 *   - 客户端通过 x-mineru-target-path header 指定 mineru.net 上的 path
 *     （例：/api/v4/file-urls/batch, /api/v4/extract-results/batch/<id>）
 *   - x-mineru-base-url 仅供白名单校验；最终拼出的 URL 由系统设置的 MinerU BaseURL 决定
 *   - method / body 原样透传
 *
 * 注意：OSS PUT 不会经过本端点（客户端的 cloudFetch 已对 *.aliyuncs.com 强制
 * 改走原 cloud proxy 的零干扰透传），所以本路由无需处理 OSS 签名签字逻辑。
 */

import { NextRequest, NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { randomUUID } from "crypto";
import { noStoreHeaders } from "@/lib/ai";
import {
  getMinerUAuthorizationFromEnv,
  isMinerUServiceAllowed,
  MinerUAuthorizationRecord,
  getMinerUIdentityFromServicePrincipal,
  normalizeMinerUCloudBaseUrl,
  resolveAllowedMinerUOperation,
} from "@/lib/built-in-api-service/mineru-authorization";
import { getMinerURuntimeSettings } from "@/lib/built-in-api-service/mineru-settings";
import { quotaService } from "@/lib/built-in-api-service/quota-service";
import { attachQuotaReleaseToResponse } from "@/lib/built-in-api-service/legacy-quota";
import { fetchPublicHttpUrl } from "@/lib/network/public-url";
import {
  requireServicePrincipal,
  ServicePrincipalError,
} from "@/lib/auth/service-principal";

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

async function loadAuthorization(userId: string, email?: string): Promise<MinerUAuthorizationRecord | null> {
  try {
    const { rows } = await sql`
      SELECT user_id, email, status, can_use_built_in_services, allowed_services,
             daily_requests, monthly_requests, concurrent_requests
      FROM authorized_users
      WHERE LOWER(user_id) = LOWER(${userId}) OR LOWER(email) = LOWER(${email || ""})
      LIMIT 1
    `;
    if (!rows.length) return getMinerUAuthorizationFromEnv(userId, email);
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
    console.error("[mineru/proxy] loadAuthorization 失败:", error);
    throw error;
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

const stripTrailingSlash = (s: string) => s.replace(/\/+$/, "");

async function forward(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const startedAt = Date.now();

  // 1. 校验精确 method/path 操作白名单
  const targetPath = req.headers.get("x-mineru-target-path") || "";
  const operation = resolveAllowedMinerUOperation(req.method, targetPath);
  if (!operation) {
    return json(405, { code: -1, msg: "MinerU operation is not allowed" });
  }

  // 2. 读取 admin-panel 可维护的 MinerU 运行时配置
  const settings = await getMinerURuntimeSettings();
  if (!settings.enabled) {
    return json(503, {
      code: -1,
      msg: "服务端未启用 MinerU 内置云端服务",
    });
  }
  const token = settings.apiToken;
  if (!token) {
    return json(503, {
      code: -1,
      msg: "服务端未配置 MinerU API Token",
    });
  }

  const baseUrl = normalizeMinerUCloudBaseUrl(settings.baseUrl || "");
  if (!baseUrl) {
    return json(503, { code: -1, msg: "MinerU BaseURL 必须是 https://mineru.net" });
  }

  // 3. Clerk Bearer service principal 鉴权
  let identity;
  try {
    identity = getMinerUIdentityFromServicePrincipal(
      await requireServicePrincipal(req)
    );
  } catch (error) {
    const message =
      error instanceof ServicePrincipalError ? error.message : "身份验证失败";
    return json(401, { code: -1, msg: message });
  }

  // 4. 授权校验
  let authorization: MinerUAuthorizationRecord | null;
  try {
    authorization = await loadAuthorization(identity.userId, identity.email);
  } catch {
    return json(503, { code: -1, msg: "授权服务暂不可用" });
  }
  if (!authorization) {
    return json(403, { code: -1, msg: "用户未被加入授权名单" });
  }
  if (authorization.status !== "active") {
    return json(403, { code: -1, msg: `用户状态为 ${authorization.status}` });
  }
  if (!authorization.canUseBuiltInServices) {
    return json(403, { code: -1, msg: "账号未开启内置服务权限" });
  }
  if (!isMinerUServiceAllowed(authorization.allowedServices)) {
    return json(403, { code: -1, msg: "账号未被授权使用 MinerU 服务" });
  }

  // 5. 在任何上游 dispatch 之前原子计数并预留并发槽位。
  const quota = await quotaService.acquire({
    userId: authorization.userId,
    serviceId: "built-in-mineru",
    limits: {
      dailyRequests: authorization.dailyRequests,
      monthlyRequests: authorization.monthlyRequests,
      concurrentRequests: authorization.concurrentRequests,
    },
  });
  if (quota.acquired === false) {
    if (quota.reason === "database_error") {
      return json(503, { code: -1, msg: "配额服务暂不可用" });
    }
    return json(429, { code: -1, msg: "请求配额已用尽" });
  }

  // 6. 构造上游 URL
  const upstreamUrl = `${stripTrailingSlash(baseUrl)}${operation.path}`;

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
    upstream = await fetchPublicHttpUrl(upstreamUrl, {
      method,
      headers: fwdHeaders,
      body,
      redirect: "manual",
    }, {
      description: "MinerU upstream",
      allowHttp: false,
      allowPrivateNetwork: false,
      maxRedirects: 0,
    });
  } catch (err) {
    const released = await quotaService.release(quota.reservationId);
    if (!released.released) {
      return json(503, { code: -1, msg: "配额服务暂不可用" });
    }
    const dispatchError = err instanceof Error ? err.message : String(err);
    void recordUsage({
      requestId,
      userId: authorization.userId,
      success: false,
      responseTime: Date.now() - startedAt,
      error: `fetch_failed: ${dispatchError}`,
    });
    return json(502, {
      code: -1,
      msg: `mineru.net 转发失败: ${dispatchError}`,
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

  return await attachQuotaReleaseToResponse(new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: resHeaders,
  }), quota.reservationId, "mineru/proxy");
}

export async function GET(req: NextRequest) {
  return forward(req);
}
export async function POST(req: NextRequest) {
  return forward(req);
}
