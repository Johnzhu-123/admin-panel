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
 * 业务参数默认值通过环境变量配置（管理员在 Render/Zeabur 后台调整即可，无需发版）：
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const json = (status: number, payload: Record<string, unknown>) =>
  NextResponse.json(payload, { status, headers: noStoreHeaders() });

const envBool = (key: string, fallback: boolean): boolean => {
  const v = (process.env[key] || "").trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  return fallback;
};

const envString = (key: string, fallback: string): string => {
  const v = (process.env[key] || "").trim();
  return v || fallback;
};

const envCsv = (key: string): string[] => {
  const v = (process.env[key] || "").trim();
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
};

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
    console.error("[mineru/config] loadAuthorization 失败:", error);
    return null;
  }
}

const defaultOptionsFromEnv = () => ({
  modelVersion: envString("MINERU_DEFAULT_MODEL_VERSION", "vlm"),
  language: envString("MINERU_DEFAULT_LANGUAGE", "ch"),
  enableFormula: envBool("MINERU_DEFAULT_ENABLE_FORMULA", true),
  enableTable: envBool("MINERU_DEFAULT_ENABLE_TABLE", true),
  isOcr: envBool("MINERU_DEFAULT_IS_OCR", false),
  extraFormats: envCsv("MINERU_DEFAULT_EXTRA_FORMATS"),
});

const baseUrlFromEnv = (): string =>
  envString("MINERU_BUILT_IN_BASE_URL", "https://mineru.net");

const tokenConfigured = (): boolean => {
  const token = (process.env.MINERU_BUILT_IN_API_TOKEN || "").trim();
  return token.length > 0;
};

export async function GET(_req: NextRequest) {
  const defaultOptions = defaultOptionsFromEnv();
  const baseUrl = baseUrlFromEnv();

  if (!tokenConfigured()) {
    return json(200, {
      authorized: false,
      reason: "服务端未配置 MINERU_BUILT_IN_API_TOKEN",
      baseUrl,
      defaultOptions,
    });
  }

  let user;
  try {
    user = await currentUser();
  } catch (err) {
    return json(200, {
      authorized: false,
      reason: `Clerk 校验失败: ${err instanceof Error ? err.message : String(err)}`,
      baseUrl,
      defaultOptions,
    });
  }

  if (!user) {
    return json(200, {
      authorized: false,
      reason: "未登录",
      baseUrl,
      defaultOptions,
    });
  }

  const userId = user.id;
  const email =
    user.primaryEmailAddress?.emailAddress ||
    user.emailAddresses?.[0]?.emailAddress ||
    "";

  const authorization = await loadAuthorization(userId, email);
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
  const allowedServices = authorization.allowedServices;
  if (
    allowedServices.length &&
    !allowedServices.includes("mineru") &&
    !allowedServices.includes("material-extract") &&
    !allowedServices.includes("*")
  ) {
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
    quotaLimits: {
      dailyRequests: authorization.dailyRequests,
      monthlyRequests: authorization.monthlyRequests,
    },
  });
}
