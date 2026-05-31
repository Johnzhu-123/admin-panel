/**
 * MinerU 内置云端服务 — 配置发现端点（admin-panel 侧）
 * -----------------------------------------------------------------
 * 客户端通过 md2pptWin 同源代理调用此端点，得到：
 *   1. 当前用户的授权状态（authorized_users 表 + canUseBuiltInServices）
 *   2. MinerU 业务参数默认值（modelVersion / language / formula / table / OCR）
 *
 * 未授权用户也返回 200 + authorized=false，让客户端 UI 据此决定是否启用 built-in-cloud
 * 默认引擎。真正的请求转发在 `/api/material-extract/mineru/proxy/route.ts` 里做。
 *
 * 业务参数默认值由 admin-panel「系统设置」维护，并以环境变量作为初始兜底：
 *   MINERU_DEFAULT_MODEL_VERSION  — 默认 "vlm"
 *   MINERU_DEFAULT_LANGUAGE       — 默认 "ch"
 *   MINERU_DEFAULT_ENABLE_FORMULA — "true" / "false"，默认 true
 *   MINERU_DEFAULT_ENABLE_TABLE   — "true" / "false"，默认 true
 *   MINERU_DEFAULT_IS_OCR         — "true" / "false"，默认 false
 *   MINERU_DEFAULT_EXTRA_FORMATS  — 逗号分隔（docx,html,latex），默认空
 */

import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";
import { noStoreHeaders } from "@/lib/ai";
import {
  isMinerUServiceAllowed,
  resolveMinerURequestIdentity,
} from "@/lib/built-in-api-service/mineru-authorization";
import { getMinerURuntimeSettings } from "@/lib/built-in-api-service/mineru-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

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
      WHERE LOWER(user_id) = LOWER(${userId}) OR LOWER(email) = LOWER(${email || ""})
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
    console.error("[mineru/config] loadAuthorization 失败:", error);
    return null;
  }
}

export async function GET(req: NextRequest) {
  const settings = await getMinerURuntimeSettings();
  const defaultOptions = settings.defaultOptions;
  const baseUrl = settings.baseUrl;

  if (!settings.enabled) {
    return json(200, {
      authorized: false,
      reason: "服务端未启用 MinerU 内置云端服务",
      baseUrl,
      defaultOptions,
    });
  }

  if (!settings.apiToken) {
    return json(200, {
      authorized: false,
      reason: "服务端未配置 MinerU API Token",
      baseUrl,
      defaultOptions,
    });
  }

  let user: Awaited<ReturnType<typeof currentUser>> | null = null;
  try {
    user = await currentUser();
  } catch (err) {
    console.warn(
      "[mineru/config] Clerk 校验失败，尝试使用桌面端转发身份:",
      err instanceof Error ? err.message : String(err)
    );
  }

  const identity = resolveMinerURequestIdentity(user, req.headers);
  if (!identity) {
    return json(200, {
      authorized: false,
      reason: "未登录",
      baseUrl,
      defaultOptions,
    });
  }

  const authorization = await loadAuthorization(identity.userId, identity.email);
  if (!authorization) {
    return json(200, {
      authorized: false,
      reason: "用户未被加入授权名单",
      baseUrl,
      defaultOptions,
    });
  }
  if (authorization.status !== "active") {
    return json(200, {
      authorized: false,
      reason: `用户状态为 ${authorization.status}`,
      baseUrl,
      defaultOptions,
    });
  }
  if (!authorization.canUseBuiltInServices) {
    return json(200, {
      authorized: false,
      reason: "账号未开启内置服务权限",
      baseUrl,
      defaultOptions,
    });
  }
  if (!isMinerUServiceAllowed(authorization.allowedServices)) {
    return json(200, {
      authorized: false,
      reason: "账号未被授权使用 MinerU 服务",
      baseUrl,
      defaultOptions,
    });
  }

  return json(200, {
    authorized: true,
    baseUrl,
    defaultOptions,
    identitySource: identity.source,
    quotaLimits: {
      dailyRequests: authorization.dailyRequests,
      monthlyRequests: authorization.monthlyRequests,
    },
  });
}
