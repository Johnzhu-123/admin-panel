import { NextResponse } from "next/server";
import { noStoreHeaders } from "@/lib/ai";
import { assertPublicHttpUrl } from "@/lib/network/public-url";
import {
  serverFetchWithRetry,
  serverReadErrorMessage,
} from "@/lib/network/server-fetch-with-retry";
import { injectBuiltInCategoryConfig } from "@/lib/built-in-api-service/apply-cloud-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

const BUILT_IN_PROXY_HEADER = "x-built-in-service-server-url";
const normalizeRemoteBase = (base?: string) =>
  (base || "").trim().replace(/\/+$/, "");

const getRemoteBuiltInBase = (req: Request) => {
  const fromHeader = normalizeRemoteBase(req.headers.get(BUILT_IN_PROXY_HEADER) || "");
  if (fromHeader && process.env.ELECTRON_DESKTOP === "1") return fromHeader;
  const raw =
    process.env.BUILT_IN_SERVICE_SERVER_URL ||
    process.env.NEXT_PUBLIC_BUILT_IN_SERVICE_SERVER_URL ||
    "";
  const normalized = normalizeRemoteBase(raw);
  if (!normalized) return "";
  if (process.env.ELECTRON_DESKTOP !== "1") return "";
  return normalized;
};

type VideoProxyRequest = {
  endpointUrl?: string;
  apiKey?: string;
  method?: "GET" | "POST";
  payload?: Record<string, unknown>;
  useBuiltInService?: boolean;
};

export async function POST(request: Request) {
  try {
    let body = (await request.json()) as VideoProxyRequest;

    // admin-panel 端：useBuiltInService=true 时从 catalog 注入 endpointUrl/apiKey
    if (body?.useBuiltInService === true) {
      const { body: enriched, applied, config } = await injectBuiltInCategoryConfig(
        body as unknown as Record<string, unknown>,
        "video"
      );
      if (applied && config) {
        const merged = enriched as unknown as VideoProxyRequest;
        if (!merged.endpointUrl) {
          merged.endpointUrl = `${config.baseUrl.replace(/\/+$/, "")}/video/generations`;
        }
        if (!merged.apiKey) merged.apiKey = config.apiKey;
        body = merged;
      } else {
        return NextResponse.json(
          { error: "视频服务未在管理后台启用或配置" },
          { status: 503, headers: noStoreHeaders() }
        );
      }
    }
    const endpointUrl =
      typeof body?.endpointUrl === "string" ? body.endpointUrl.trim() : "";
    const payload =
      body?.payload && typeof body.payload === "object" ? body.payload : null;
    const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
    const method = body?.method === "GET" ? "GET" : "POST";

    if (!endpointUrl) {
      return NextResponse.json(
        { error: "缺少有效的视频接口地址。" },
        { status: 400, headers: noStoreHeaders() }
      );
    }
    if (method === "POST" && !payload) {
      return NextResponse.json(
        { error: "缺少视频请求体。" },
        { status: 400, headers: noStoreHeaders() }
      );
    }

    const allowPrivateNetwork =
      process.env.MD2PPT_ALLOW_PRIVATE_API_PROXY === "1";

    let safeEndpointUrl: URL;
    try {
      safeEndpointUrl = await assertPublicHttpUrl(endpointUrl, {
        description: "视频接口地址",
        allowPrivateNetwork,
      });
    } catch (error) {
      return NextResponse.json(
        {
          error:
            error instanceof Error ? error.message : "缺少有效的视频接口地址。",
        },
        { status: 400, headers: noStoreHeaders() }
      );
    }

    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream;q=0.9, */*;q=0.8",
    };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
    }
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const upstream = await serverFetchWithRetry(
      safeEndpointUrl.toString(),
      {
        method,
        headers,
        body: method === "POST" ? JSON.stringify(payload) : undefined,
        cache: "no-store",
        redirect: "error",
      },
      {
        retries: 2,
        retryDelayMs: 2500,
        timeoutMs: 30 * 60 * 1000,
      }
    );

    if (!upstream.ok) {
      const detail = await serverReadErrorMessage(upstream);
      return NextResponse.json(
        { error: detail || `视频接口请求失败 (${upstream.status})` },
        { status: upstream.status, headers: noStoreHeaders() }
      );
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...noStoreHeaders(),
        "Content-Type":
          upstream.headers.get("content-type") ||
          "text/event-stream; charset=utf-8",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "视频代理请求失败。",
      },
      { status: 500, headers: noStoreHeaders() }
    );
  }
}
