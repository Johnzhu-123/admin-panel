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

const buildBuiltInVideoEndpoint = (baseUrl: string, endpointPath?: string) => {
  const normalized = normalizeRemoteBase(baseUrl);
  if (!normalized) return "";

  // Built-in/self-hosted video models are exposed through streaming
  // OpenAI-compatible Chat Completions unless admin explicitly overrides it.
  const pathOverride = (endpointPath || "").trim();
  if (pathOverride) {
    if (/^https?:\/\//i.test(pathOverride)) return pathOverride;
    const cleaned = pathOverride.startsWith("/") ? pathOverride : `/${pathOverride}`;
    try {
      const parsed = new URL(normalized);
      const basePath = parsed.pathname.replace(/\/+$/, "");
      if (
        basePath &&
        cleaned.toLowerCase().startsWith(`${basePath.toLowerCase()}/`)
      ) {
        parsed.pathname = cleaned;
        parsed.search = "";
        parsed.hash = "";
        return parsed.toString().replace(/\/+$/, "");
      }
    } catch {
      // Fall back to simple concatenation for non-URL bases; validation happens later.
    }
    return `${normalized}${cleaned}`;
  }

  try {
    const parsed = new URL(normalized);
    const path = parsed.pathname.replace(/\/+$/, "");
    if (/\/chat\/completions$/i.test(path)) {
      return normalized;
    }
  } catch {
    if (/\/chat\/completions\/?$/i.test(normalized)) {
      return normalized;
    }
  }
  return `${normalized}/chat/completions`;
};

const shouldReplaceBuiltInVideoEndpoint = (endpointUrl: string) => {
  if (!endpointUrl.trim()) return true;
  try {
    const parsed = new URL(endpointUrl);
    const path = parsed.pathname.replace(/\/+$/, "");
    return /\/(?:video\/generations|videos|generate)$/i.test(path);
  } catch {
    return /\/(?:video\/generations|videos|generate)\/?$/i.test(endpointUrl);
  }
};

const isChatCompletionsEndpoint = (endpointUrl: string) => {
  try {
    const parsed = new URL(endpointUrl);
    return /\/chat\/completions\/?$/i.test(parsed.pathname);
  } catch {
    return /\/chat\/completions\/?$/i.test(endpointUrl);
  }
};

const extractBase64FromDataUrl = (value: unknown) => {
  if (typeof value !== "string") return "";
  const match = value.match(/^data:[^;]+;base64,(.+)$/i);
  return match?.[1] || "";
};

const normalizeVideoPayloadForChatCompletions = (
  payload: Record<string, unknown> | null,
  fallbackModel: string
): Record<string, unknown> | null => {
  if (!payload) return payload;
  if (Array.isArray(payload.messages)) {
    return {
      ...payload,
      model:
        typeof payload.model === "string" && payload.model.trim()
          ? payload.model
          : fallbackModel,
      stream: true,
    };
  }

  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  const firstFrame =
    extractBase64FromDataUrl(payload.image) ||
    extractBase64FromDataUrl(payload.first_frame) ||
    (typeof payload.image === "string" ? payload.image : "") ||
    (typeof payload.first_frame === "string" ? payload.first_frame : "");
  const lastFrame =
    extractBase64FromDataUrl(payload.last_frame) ||
    (typeof payload.last_frame === "string" ? payload.last_frame : "");
  if (firstFrame) {
    content.push({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${firstFrame}` },
    });
  }
  if (lastFrame) {
    content.push({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${lastFrame}` },
    });
  }
  return {
    model:
      typeof payload.model === "string" && payload.model.trim()
        ? payload.model
        : fallbackModel,
    messages: [
      {
        role: "user",
        content: content.length === 1 ? prompt : content,
      },
    ],
    stream: true,
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
  userId?: string;
};

async function recordBuiltInVideoUsage(
  body: VideoProxyRequest | null | undefined,
  success: boolean,
  startedAt: number,
  error?: string
) {
  if (body?.useBuiltInService !== true) return;
  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  if (!userId) return;
  try {
    const { recordUsageToDatabase } = await import("@/lib/built-in-api-service/db");
    await recordUsageToDatabase(
      `video_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      userId,
      "video/default",
      success,
      Math.max(1, Date.now() - startedAt),
      error
    );
  } catch (usageError) {
    console.error("[Video API] failed to record usage:", usageError);
  }
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  let bodyForUsage: VideoProxyRequest | null = null;
  try {
    let body = (await request.json()) as VideoProxyRequest;
    bodyForUsage = body;

    // admin-panel 端：useBuiltInService=true 时从 catalog 注入 endpointUrl/apiKey
    if (body?.useBuiltInService === true) {
      const { body: enriched, applied, config } = await injectBuiltInCategoryConfig(
        body as unknown as Record<string, unknown>,
        "video",
        {
          // 🔧 FIX (2026-06-11 BUG-D2): 透传用户所选视频模型（本路由模型在 payload.model），
          //   命中 subtask.model/models[] 时生效，否则回退默认模型。
          requestedModel:
            typeof body?.payload?.model === "string" ? body.payload.model : "",
        }
      );
      if (applied && config) {
        const merged = enriched as unknown as VideoProxyRequest;
        // 🔧 FIX (2026-06-11 BUG-D2): 请求的模型未通过允许列表校验时，把 payload.model
        //   覆写为回退后的默认模型，避免无效模型原样发往上游。
        if (
          config.modelFallback === true &&
          merged.payload &&
          typeof merged.payload.model === "string"
        ) {
          merged.payload = { ...merged.payload, model: config.model };
        }
        const currentEndpoint =
          typeof merged.endpointUrl === "string" ? merged.endpointUrl.trim() : "";
        const replacedEndpoint =
          !!config.endpointPath || shouldReplaceBuiltInVideoEndpoint(currentEndpoint);
        if (replacedEndpoint) {
          merged.endpointUrl = buildBuiltInVideoEndpoint(config.baseUrl, config.endpointPath);
        }
        if (isChatCompletionsEndpoint(merged.endpointUrl || "")) {
          merged.payload = normalizeVideoPayloadForChatCompletions(
            merged.payload || null,
            config.model
          ) || merged.payload;
        }
        if (!merged.apiKey) merged.apiKey = config.apiKey;
        body = merged;
        bodyForUsage = body;
      } else {
        await recordBuiltInVideoUsage(bodyForUsage, false, startedAt, "视频服务未在管理后台启用或配置");
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
      await recordBuiltInVideoUsage(bodyForUsage, false, startedAt, "缺少有效的视频接口地址。");
      return NextResponse.json(
        { error: "缺少有效的视频接口地址。" },
        { status: 400, headers: noStoreHeaders() }
      );
    }
    if (method === "POST" && !payload) {
      await recordBuiltInVideoUsage(bodyForUsage, false, startedAt, "缺少视频请求体。");
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
      await recordBuiltInVideoUsage(bodyForUsage, false, startedAt, "视频请求体过大。");
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
      await recordBuiltInVideoUsage(
        bodyForUsage,
        false,
        startedAt,
        error instanceof Error ? error.message : "缺少有效的视频接口地址。"
      );
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
      await recordBuiltInVideoUsage(
        bodyForUsage,
        false,
        startedAt,
        detail || `视频接口请求失败 (${upstream.status})`
      );
      return NextResponse.json(
        { error: detail || `视频接口请求失败 (${upstream.status})` },
        { status: upstream.status, headers: noStoreHeaders() }
      );
    }

    await recordBuiltInVideoUsage(bodyForUsage, true, startedAt);
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
    await recordBuiltInVideoUsage(
      bodyForUsage,
      false,
      startedAt,
      error instanceof Error ? error.message : "视频代理请求失败。"
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "视频代理请求失败。",
      },
      { status: 500, headers: noStoreHeaders() }
    );
  }
}
