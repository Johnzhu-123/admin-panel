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

const MAX_VIDEO_UPSTREAM_BODY_CHARS = 8_000_000;

const BUILT_IN_PROXY_HEADER = "x-built-in-service-server-url";
const normalizeRemoteBase = (base?: string) =>
  (base || "").trim().replace(/\/+$/, "");

const buildBuiltInVideoEndpoint = (baseUrl: string) => {
  const normalized = normalizeRemoteBase(baseUrl);
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    const path = parsed.pathname.replace(/\/+$/, "");
    if (/\/(?:video\/generations|videos|generate)$/i.test(path)) {
      return normalized;
    }
  } catch {
    if (/\/(?:video\/generations|videos|generate)\/?$/i.test(normalized)) {
      return normalized;
    }
  }
  return `${normalized}/video/generations`;
};

const shouldReplaceBuiltInVideoEndpoint = (endpointUrl: string) => {
  if (!endpointUrl.trim()) return true;
  try {
    const parsed = new URL(endpointUrl);
    const path = parsed.pathname.replace(/\/+$/, "");
    return /\/chat\/completions$/i.test(path);
  } catch {
    return /\/chat\/completions\/?$/i.test(endpointUrl);
  }
};

const extractBase64FromDataUrl = (value: unknown) => {
  if (typeof value !== "string") return "";
  const match = value.match(/^data:[^;]+;base64,(.+)$/i);
  return match?.[1] || "";
};

const normalizeChatPayloadForVideoGeneration = (
  payload: Record<string, unknown> | null,
  fallbackModel: string
): Record<string, unknown> | null => {
  if (!payload || !Array.isArray(payload.messages)) return payload;
  const texts: string[] = [];
  const images: string[] = [];

  for (const message of payload.messages) {
    if (!message || typeof message !== "object") continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string" && content.trim()) {
      texts.push(content.trim());
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const typedPart = part as {
        type?: unknown;
        text?: unknown;
        image_url?: { url?: unknown };
      };
      if (typedPart.type === "text" && typeof typedPart.text === "string") {
        texts.push(typedPart.text.trim());
      }
      if (typedPart.type === "image_url") {
        const base64 = extractBase64FromDataUrl(typedPart.image_url?.url);
        if (base64) images.push(base64);
      }
    }
  }

  const prompt = texts.filter(Boolean).join("\n\n").trim();
  const rest = { ...payload };
  delete rest.messages;
  delete rest.stream;
  return {
    ...rest,
    model:
      typeof payload.model === "string" && payload.model.trim()
        ? payload.model
        : fallbackModel,
    prompt,
    duration: typeof payload.duration === "number" ? payload.duration : 5,
    ...(images[0] ? { image: images[0] } : {}),
    ...(images[1] ? { last_frame: images[1] } : {}),
  };
};

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
        const currentEndpoint =
          typeof merged.endpointUrl === "string" ? merged.endpointUrl.trim() : "";
        const replacedEndpoint = shouldReplaceBuiltInVideoEndpoint(currentEndpoint);
        if (replacedEndpoint) {
          merged.endpointUrl = buildBuiltInVideoEndpoint(config.baseUrl);
          merged.payload = normalizeChatPayloadForVideoGeneration(
            merged.payload || null,
            config.model
          ) || merged.payload;
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
    const upstreamBody = method === "POST" ? JSON.stringify(payload) : undefined;
    if (
      typeof upstreamBody === "string" &&
      upstreamBody.length > MAX_VIDEO_UPSTREAM_BODY_CHARS
    ) {
      return NextResponse.json(
        {
          error:
            `视频请求体过大（约 ${Math.ceil(upstreamBody.length / 1024 / 1024)}MB），` +
            "已在服务端拦截以避免上游 JSON 被截断。请降低首帧/尾帧尺寸后重试。",
        },
        { status: 413, headers: noStoreHeaders() }
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
        body: upstreamBody,
        cache: "no-store",
        redirect: "error",
      },
      {
        retries: method === "GET" ? 2 : 1,
        retryDelayMs: 2500,
        timeoutMs: 30 * 60 * 1000,
        retryOnStatuses: method === "GET" ? undefined : [],
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
