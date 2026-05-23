import { NextResponse } from "next/server";
import {
  buildOpenAiHeaders,
  containsNonAsciiText,
  convertJsonStringsToAsciiLiterals,
  formatAsciiCodecCompatMessage,
  isAsciiCodecError,
  looksLikeGeminiModel,
  normalizeOpenAiAuthHeader,
  normalizeGeminiBaseUrl,
  noStoreHeaders,
  normalizeOpenAiBaseUrl,
  stringifyJsonAsciiSafe,
} from "@/lib/ai";
import type { InlineImage } from "@/lib/ai";
import { recordFailureLog } from "@/lib/diagnostics";
import { enhanceOpenAICompatibility } from "@/lib/api-compatibility/integration";
import {
  serverFetchWithRetry,
  serverRequestTextWithRetry,
  serverReadErrorMessage,
} from "@/lib/network/server-fetch-with-retry";
import {
  describeOpenAiCompatibleEmptyReason,
  extractOpenAiCompatibleError,
  extractOpenAiCompatibleText,
  parseOpenAiCompatibleResponseText,
  summarizeOpenAiCompatiblePayload,
} from "@/lib/openai-compatible-response";
import { injectBuiltInCategoryConfig } from "@/lib/built-in-api-service/apply-cloud-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

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

const shouldUseGeminiAlpha = (model: string) =>
  /preview|exp|experimental|alpha/i.test(model);

const toInlinePart = (img: InlineImage) => ({
  inlineData: { mimeType: img.mimeType, data: img.data },
});

const buildGeminiRestUrl = (baseUrl: string, apiVersion: string, model: string) =>
  `${baseUrl.replace(/\/+$/, "")}/${apiVersion}/models/${encodeURIComponent(
    model
  )}:generateContent`;

const buildGeminiRestBody = (prompt: string, images: InlineImage[]) => ({
  contents: [
    {
      role: "user",
      parts: images.length ? [{ text: prompt }, ...images.map(toInlinePart)] : [{ text: prompt }],
    },
  ],
});

const buildGeminiAsciiLiteralBody = (prompt: string, images: InlineImage[]) =>
  convertJsonStringsToAsciiLiterals(buildGeminiRestBody(prompt, images));

const ANALYZE_REQUEST_TIMEOUT_MS = 180000;

const summarizeBaseUrlForLog = (raw?: string) => {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return trimmed.slice(0, 160);
  }
};

const isGoogleGenerativeLanguageHost = (rawUrl: string) => {
  try {
    const url = new URL(rawUrl);
    return /(^|\.)generativelanguage\.googleapis\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
};

const parseJsonLikeText = (text: string) => {
  return parseOpenAiCompatibleResponseText(text);
};

const extractRemoteErrorText = (text: string, fallback = "") => {
  if (!text) return fallback;
  try {
    const data = parseJsonLikeText(text);
    const message = data?.error?.message || data?.error || data?.message || data?.detail;
    return typeof message === "string" && message.trim() ? message.trim() : text;
  } catch {
    return text;
  }
};

const extractGeminiText = (payload: any) => {
  const direct = typeof payload?.text === "string" ? payload.text.trim() : "";
  if (direct) return direct;
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  const parts = candidates.flatMap((candidate: any) =>
    Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []
  );
  return parts
    .map((part: any) => (typeof part?.text === "string" ? part.text.trim() : ""))
    .filter(Boolean)
    .join("\n");
};

const normalizeOpenAiAnalyzeError = (
  status: number,
  detail: string,
  model: string
) => {
  let errorMessage = detail || `HTTP ${status}`;

  try {
    const parsed = JSON.parse(detail);
    errorMessage =
      parsed?.error?.message ||
      parsed?.error ||
      parsed?.message ||
      parsed?.detail ||
      errorMessage;
  } catch {
    // Keep the raw detail when the payload is not JSON.
  }

  const lowered = errorMessage.toLowerCase();
  if (status === 404 && lowered.includes("not found")) {
    errorMessage = "API endpoint not found. This service may expose OpenAI-compatible routes instead of Gemini generateContent routes.";
  } else if (status === 422 && lowered.includes("model")) {
    errorMessage = `Model "${model}" may not be supported by this compatibility service.`;
  } else if (
    status === 400 &&
    (lowered.includes("messages") ||
      lowered.includes("format") ||
      lowered.includes("parameter") ||
      lowered.includes("validation"))
  ) {
    errorMessage = "The compatibility service rejected the request format. It may require OpenAI chat/completions-compatible parameters.";
  } else if (status === 401 || status === 403) {
    errorMessage = "Authentication failed. Please verify the API key and authentication header mode.";
  }

  return formatAsciiCodecCompatMessage(errorMessage);
};

const runOpenAiCompatibleAnalyzeRequest = async (options: {
  provider: "openai" | "gemini_compat";
  apiKey: string;
  baseUrl: string;
  authHeader?: string;
  requestedTextModel?: string;
  requestedVisionModel?: string;
  prompt: string;
  images: InlineImage[];
}) => {
  const normalizedBaseUrl = normalizeOpenAiBaseUrl(options.baseUrl);
  const openAiAuthHeader = normalizeOpenAiAuthHeader(options.authHeader);
  const requestedTextModel = (options.requestedTextModel || "").trim();
  const requestedVisionModel = (options.requestedVisionModel || "").trim();
  const candidateModels = Array.from(
    new Set(
      (
        options.images.length
          ? [requestedVisionModel, requestedTextModel]
          : [requestedTextModel]
      ).filter((value) => value && value.trim())
    )
  );

  if (!candidateModels.length) {
    throw new Error(
      options.images.length
        ? "Missing openAiVisionModel/openAiTextModel/model. 请先明确指定素材分析模型。"
        : "Missing openAiTextModel/model. 请先明确指定文本分析模型。"
    );
  }

  const requestUrl = `${normalizedBaseUrl}/chat/completions`;
  const errors: string[] = [];

  const runAttempt = async (candidateModel: string, useAsciiLiteralPayload: boolean) => {
    const isReasoningLike = /gpt-5|o1|o3|o4|reasoning|think/i.test(candidateModel);
    const rawRequestBody: Record<string, unknown> = {
      model: candidateModel,
      max_tokens: 8192,
      messages: [
        {
          role: "system",
          content:
            "你是一位多模态内容分析专家。请根据用户提供的素材生成结构化的 JSON 分析报告。",
        },
        options.images.length
          ? {
              role: "user",
              content: [
                { type: "text", text: options.prompt },
                ...options.images.map((img) => ({
                  type: "image_url",
                  image_url: {
                    url: `data:${img.mimeType};base64,${img.data}`,
                  },
                })),
              ],
            }
          : { role: "user", content: options.prompt },
      ],
    };
    if (!isReasoningLike) {
      rawRequestBody.temperature = 0.5;
    }

    const requestBody = useAsciiLiteralPayload
      ? convertJsonStringsToAsciiLiterals(rawRequestBody)
      : rawRequestBody;

    const enhancedConfig = await enhanceOpenAICompatibility(
      {
        url: requestUrl,
        method: "POST",
        headers: {
          ...buildOpenAiHeaders(options.apiKey, true, openAiAuthHeader),
        },
        body: requestBody,
      },
      {
        provider: options.provider,
        baseUrl: normalizedBaseUrl,
        operation: "chat/completions",
      }
    );

    const res = await serverFetchWithRetry(
      enhancedConfig.url,
      {
        method: enhancedConfig.method,
        headers: enhancedConfig.headers,
        body: stringifyJsonAsciiSafe(enhancedConfig.body),
        cache: "no-store",
      },
      {
        retries: 2,
        retryDelayMs: 2500,
        timeoutMs: ANALYZE_REQUEST_TIMEOUT_MS,
      }
    );

    if (!res.ok) {
      const detail = await serverReadErrorMessage(res);
      const normalizedDetail = normalizeOpenAiAnalyzeError(
        res.status,
        detail,
        candidateModel
      );
      recordFailureLog({
        provider: options.provider,
        operation: "chat/completions (analyze-materials)",
        url: enhancedConfig.url,
        status: res.status,
        requestBody: {
          model: candidateModel,
          asciiLiteralPayload: useAsciiLiteralPayload,
        },
        responseBody: normalizedDetail,
      });
      throw new Error(normalizedDetail || `HTTP ${res.status}`);
    }

    const rawText = await res.text();
    const data = parseJsonLikeText(rawText);
    const upstreamError = extractOpenAiCompatibleError(data);
    if (upstreamError) {
      recordFailureLog({
        provider: options.provider,
        operation: "chat/completions (analyze-materials-envelope-error)",
        url: enhancedConfig.url,
        status: res.status,
        requestBody: {
          model: candidateModel,
          asciiLiteralPayload: useAsciiLiteralPayload,
        },
        responseBody: data,
      });
      throw new Error(formatAsciiCodecCompatMessage(upstreamError));
    }

    const text = extractOpenAiCompatibleText(data);
    if (text) {
      return text;
    }

    const emptyReason = describeOpenAiCompatibleEmptyReason(data);
    const preview = summarizeOpenAiCompatiblePayload(data);
    const detailParts = [emptyReason, preview ? `响应预览：${preview}` : ""].filter(Boolean);
    const emptyResponseMessage = detailParts.length
      ? `模型 ${candidateModel} 返回了空内容（${detailParts.join("；")}）`
      : `模型 ${candidateModel} 返回了空内容`;
    recordFailureLog({
      provider: options.provider,
      operation: "chat/completions (analyze-materials-empty)",
      url: enhancedConfig.url,
      status: res.status,
      requestBody: {
        model: candidateModel,
        asciiLiteralPayload: useAsciiLiteralPayload,
      },
      responseBody: data,
    });
    throw new Error(emptyResponseMessage);
  };

  for (const candidateModel of candidateModels) {
    let firstErrorMessage = "";
    try {
      return await runAttempt(candidateModel, false);
    } catch (firstError) {
      firstErrorMessage = formatAsciiCodecCompatMessage(
        firstError instanceof Error ? firstError.message : String(firstError || "")
      );
    }

    const shouldRetryAsciiLiteralPayload =
      isAsciiCodecError(firstErrorMessage) && containsNonAsciiText(options.prompt);
    if (shouldRetryAsciiLiteralPayload) {
      console.log(
        "[analyze-materials] Retrying OpenAI-compatible request with ASCII-literal prompt payload.",
        {
          provider: options.provider,
          model: candidateModel,
          baseUrl: summarizeBaseUrlForLog(normalizedBaseUrl),
        }
      );
      try {
        return await runAttempt(candidateModel, true);
      } catch (retryError) {
        const retryErrorMessage = formatAsciiCodecCompatMessage(
          retryError instanceof Error ? retryError.message : String(retryError || "")
        );
        errors.push(
          `${candidateModel}: ${firstErrorMessage}；ASCII 字面量重试失败：${retryErrorMessage}`
        );
        continue;
      }
    }

    errors.push(`${candidateModel}: ${firstErrorMessage}`);
  }

  throw new Error(
    errors.length > 0
      ? `素材分析未返回可用文本。已尝试模型：${errors.join(" | ")}`
      : "素材分析未返回可用文本。"
  );
};

// 2026-05-23：streaming 路径
// 客户端在 body 里显式带 `stream: true` 时启用。
// 上游 OpenAI-compatible chat/completions 用 stream:true 后会返回 SSE，
// admin-panel 把 res.body 这个 ReadableStream 原样 pipe 给下游 Response，
// 避免在中间层 buffer 完整响应。
// 关键作用：让上游 API gateway 前面的 Cloudflare 看到持续 chunk 抵达，
// 不再因 100s 内无字节而触发 524。
const streamOpenAiCompatibleAnalyzeRequest = async (options: {
  provider: "openai" | "gemini_compat";
  apiKey: string;
  baseUrl: string;
  authHeader?: string;
  requestedTextModel: string;
  prompt: string;
}): Promise<Response> => {
  const normalizedBaseUrl = normalizeOpenAiBaseUrl(options.baseUrl);
  const openAiAuthHeader = normalizeOpenAiAuthHeader(options.authHeader);
  const candidateModel = (options.requestedTextModel || "").trim();
  if (!candidateModel) {
    return NextResponse.json(
      { error: "Missing openAiTextModel/model. 请先明确指定文本分析模型。" },
      { status: 400, headers: noStoreHeaders() }
    );
  }

  const isReasoningLike = /gpt-5|o1|o3|o4|reasoning|think/i.test(candidateModel);
  const requestUrl = `${normalizedBaseUrl}/chat/completions`;

  const rawRequestBody: Record<string, unknown> = {
    model: candidateModel,
    max_tokens: 8192,
    stream: true,
    messages: [
      {
        role: "system",
        content:
          "你是一位多模态内容分析专家。请根据用户提供的素材生成结构化的 JSON 分析报告。",
      },
      { role: "user", content: options.prompt },
    ],
  };
  if (!isReasoningLike) {
    rawRequestBody.temperature = 0.5;
  }

  const enhancedConfig = await enhanceOpenAICompatibility(
    {
      url: requestUrl,
      method: "POST",
      headers: {
        ...buildOpenAiHeaders(options.apiKey, true, openAiAuthHeader),
        Accept: "text/event-stream",
      },
      body: rawRequestBody,
    },
    {
      provider: options.provider,
      baseUrl: normalizedBaseUrl,
      operation: "chat/completions",
    }
  );

  let upstream: Response;
  try {
    upstream = await serverFetchWithRetry(
      enhancedConfig.url,
      {
        method: enhancedConfig.method,
        headers: enhancedConfig.headers,
        body: stringifyJsonAsciiSafe(enhancedConfig.body),
        cache: "no-store",
      },
      {
        // streaming 模式不重试：响应一旦开始读就无法回放
        retries: 1,
        retryDelayMs: 0,
        timeoutMs: ANALYZE_REQUEST_TIMEOUT_MS,
      }
    );
  } catch (fetchError) {
    const fetchMessage =
      fetchError instanceof Error
        ? fetchError.message
        : String(fetchError || "OpenAI-compatible analyze stream request failed.");
    recordFailureLog({
      provider: options.provider,
      operation: "chat/completions (analyze-materials-stream-network)",
      url: enhancedConfig.url,
      status: null,
      requestBody: { model: candidateModel, stream: true },
      responseBody: fetchMessage,
    });
    return NextResponse.json(
      {
        error: `素材分析未返回可用文本。已尝试模型：${candidateModel}: ${formatAsciiCodecCompatMessage(
          fetchMessage
        )}`,
      },
      { status: 502, headers: noStoreHeaders() }
    );
  }

  if (!upstream.ok || !upstream.body) {
    const detail = upstream.body
      ? await serverReadErrorMessage(upstream)
      : `HTTP ${upstream.status}`;
    const normalizedDetail = normalizeOpenAiAnalyzeError(
      upstream.status,
      detail,
      candidateModel
    );
    recordFailureLog({
      provider: options.provider,
      operation: "chat/completions (analyze-materials-stream)",
      url: enhancedConfig.url,
      status: upstream.status,
      requestBody: { model: candidateModel, stream: true },
      responseBody: normalizedDetail,
    });
    return NextResponse.json(
      {
        error: `素材分析未返回可用文本。已尝试模型：${candidateModel}: ${normalizedDetail}`,
      },
      { status: upstream.status, headers: noStoreHeaders() }
    );
  }

  // 把上游 SSE 流原样 pipe 给下游，不在 admin-panel 里 buffer
  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...noStoreHeaders(),
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
};

/**
 * POST /api/ai/analyze-materials
 *
 * 多模态素材 AI 分析。接收文本内容 + 图片，返回结构化分析报告。
 * 复用 /api/ai/summary 的 provider 解析模式（Gemini / OpenAI 双通道）。
 */
export async function POST(req: Request) {
  try {
    let body = await req.json();

    // admin-panel 端：useBuiltInService=true 时从 catalog 注入 baseUrl/apiKey/model（multimodal 类别）
    if (body?.useBuiltInService === true) {
      const { body: enriched, applied } = await injectBuiltInCategoryConfig(
        body as Record<string, unknown>,
        "multimodal"
      );
      if (applied) {
        body = enriched;
      } else {
        return NextResponse.json(
          { error: "多模态服务未在管理后台启用或配置" },
          { status: 503, headers: noStoreHeaders() }
        );
      }
    }

    let provider =
      body.provider === "openai"
        ? "openai"
        : body.provider === "gemini_compat"
          ? "gemini_compat"
          : "gemini";
    const apiKey = (body.apiKey || "").trim();
    const prompt = (body.prompt || "").trim();
    const images = Array.isArray(body.images)
      ? (body.images as InlineImage[])
      : [];

    if (!apiKey || !prompt) {
      return NextResponse.json(
        { error: "Missing apiKey or prompt." },
        { status: 400, headers: noStoreHeaders() }
      );
    }

    // 2026-05-23：streaming 分支
    // 仅 OpenAI-compatible（openai / gemini_compat）路径、纯文本场景启用。
    // 让上游 SSE 直接 pipe 到下游，避免上游 API gateway 前面的 CF 524。
    // 多模态（images.length > 0）走原 buffered 路径，因为多模态推理一般 < 100s 不需要 streaming。
    const wantsStream = body?.stream === true;
    if (
      wantsStream &&
      images.length === 0 &&
      (provider === "openai" || provider === "gemini_compat")
    ) {
      const streamRequestedModel =
        provider === "openai"
          ? body.openAiTextModel || body.model
          : body.openAiTextModel || body.geminiTextModel || body.model;
      const streamRequestedBaseUrl =
        provider === "openai"
          ? body.openAiBaseUrl || body.baseUrl
          : body.geminiCompatBaseUrl || body.baseUrl;
      console.log("[analyze-materials] Streaming request:", {
        provider,
        model: String(streamRequestedModel || "").trim(),
        promptLength: prompt.length,
        baseUrl: summarizeBaseUrlForLog(streamRequestedBaseUrl),
      });
      return await streamOpenAiCompatibleAnalyzeRequest({
        provider,
        apiKey,
        baseUrl: String(streamRequestedBaseUrl || ""),
        authHeader: body.openAiAuthHeader || body.authHeader,
        requestedTextModel: String(streamRequestedModel || ""),
        prompt,
      });
    }

    const requestedBaseUrl =
      provider === "openai"
        ? body.openAiBaseUrl || body.baseUrl
        : provider === "gemini_compat"
          ? body.geminiCompatBaseUrl || body.baseUrl
          : body.baseUrl;
    const requestedModel =
      provider === "openai"
        ? (
            images.length
              ? body.openAiVisionModel || body.openAiTextModel || body.model
              : body.openAiTextModel || body.openAiVisionModel || body.model
          ) || ""
        : (body.geminiTextModel || body.model || "");

    console.log("[analyze-materials] Request:", {
      provider,
      model: typeof requestedModel === "string" ? requestedModel.trim() : "",
      promptLength: prompt.length,
      imagesCount: images.length,
      baseUrl: summarizeBaseUrlForLog(requestedBaseUrl),
    });

    if (provider === "gemini" || provider === "gemini_compat") {
      const geminiTextModel =
        (body.geminiTextModel || body.model || "").trim();
      if (!geminiTextModel) {
        return NextResponse.json(
          { error: "Missing geminiTextModel/model. 请先明确指定素材分析模型。" },
          { status: 400, headers: noStoreHeaders() }
        );
      }
      const geminiTarget = normalizeGeminiBaseUrl(
        provider === "gemini_compat" ? body.geminiCompatBaseUrl || body.baseUrl : body.baseUrl
      );
      const apiVersion = shouldUseGeminiAlpha(geminiTextModel)
        ? "v1alpha"
        : geminiTarget.apiVersion;
      const restUrl = buildGeminiRestUrl(
        geminiTarget.baseUrl,
        apiVersion || "v1beta",
        geminiTextModel
      );
      const requestBody = stringifyJsonAsciiSafe(
        buildGeminiRestBody(prompt, images)
      );
      const requestBodyAsciiLiteral = stringifyJsonAsciiSafe(
        buildGeminiAsciiLiteralBody(prompt, images)
      );

      try {
        let restResponse = await serverRequestTextWithRetry(
          restUrl,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": apiKey,
              Connection: "close",
            },
            body: requestBody,
            cache: "no-store",
          },
          {
            retries: 3,
            retryDelayMs: 2500,
            timeoutMs: ANALYZE_REQUEST_TIMEOUT_MS,
          }
        );

        if (
          (restResponse.status < 200 || restResponse.status >= 300) &&
          isAsciiCodecError(restResponse.text) &&
          containsNonAsciiText(prompt)
        ) {
          console.log(
            "[analyze-materials] Retrying Gemini REST with ASCII-literal prompt payload.",
            {
              provider,
              model: geminiTextModel,
              baseUrl: summarizeBaseUrlForLog(geminiTarget.baseUrl),
            }
          );
          restResponse = await serverRequestTextWithRetry(
            restUrl,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": apiKey,
                Connection: "close",
              },
              body: requestBodyAsciiLiteral,
              cache: "no-store",
            },
            {
              retries: 3,
              retryDelayMs: 2500,
              timeoutMs: ANALYZE_REQUEST_TIMEOUT_MS,
            }
          );
        }

        if (restResponse.status < 200 || restResponse.status >= 300) {
          const detail = extractRemoteErrorText(restResponse.text);
          throw new Error(detail || `Gemini request failed (${restResponse.status})`);
        }

        const restData = parseJsonLikeText(restResponse.text);
        const text = extractGeminiText(restData);
        if (!text) {
          throw new Error("AI 返回内容为空，请更换模型或稍后重试。");
        }

        return NextResponse.json({ text }, { headers: noStoreHeaders() });
      } catch (geminiError) {
        recordFailureLog({
          provider,
          operation: "gemini.generateContent.rest (analyze-materials)",
          url: restUrl,
          status: null,
          requestBody: {
            model: geminiTextModel,
            promptLength: prompt.length,
            imagesCount: images.length,
          },
          responseBody:
            geminiError instanceof Error ? geminiError.message : String(geminiError || ""),
        });
        if (provider !== "gemini_compat") {
          throw geminiError;
        }

        const openAiCompatBaseUrl = (
          body.baseUrl ||
          body.geminiCompatBaseUrl ||
          body.openAiBaseUrl ||
          ""
        ).trim();

        if (!openAiCompatBaseUrl) {
          throw geminiError;
        }

        try {
          const text = await runOpenAiCompatibleAnalyzeRequest({
            provider: "gemini_compat",
            apiKey,
            baseUrl: openAiCompatBaseUrl,
            authHeader: body.openAiAuthHeader || body.authHeader,
            requestedTextModel:
              body.openAiTextModel || body.geminiTextModel || body.model,
            requestedVisionModel:
              body.openAiVisionModel ||
              body.openAiTextModel ||
              body.geminiTextModel ||
              body.model,
            prompt,
            images,
          });
          return NextResponse.json({ text }, { headers: noStoreHeaders() });
        } catch (openAiCompatError) {
          const geminiMessage = formatAsciiCodecCompatMessage(
            geminiError instanceof Error ? geminiError.message : String(geminiError || "")
          );
          const compatMessage = formatAsciiCodecCompatMessage(
            openAiCompatError instanceof Error
              ? openAiCompatError.message
              : String(openAiCompatError || "")
          );

          if (compatMessage && compatMessage !== geminiMessage) {
            throw new Error(
              `Gemini 兼容接口失败：${geminiMessage}；OpenAI 兼容回退也失败：${compatMessage}`
            );
          }
          throw openAiCompatError;
        }
      }
    }

    const text = await runOpenAiCompatibleAnalyzeRequest({
      provider: "openai",
      apiKey,
      baseUrl: body.openAiBaseUrl || body.baseUrl,
      authHeader: body.openAiAuthHeader || body.authHeader,
      requestedTextModel: body.openAiTextModel || body.model,
      requestedVisionModel: body.openAiVisionModel || body.model,
      prompt,
      images,
    }).catch(async (openAiError) => {
      const fallbackModel = (
        images.length
          ? body.openAiVisionModel || body.openAiTextModel || body.model
          : body.openAiTextModel || body.openAiVisionModel || body.model
      )
        .toString()
        .trim();
      const fallbackBaseUrl = (
        body.baseUrl ||
        body.openAiBaseUrl ||
        body.geminiCompatBaseUrl ||
        ""
      )
        .toString()
        .trim();

      const geminiTarget = normalizeGeminiBaseUrl(fallbackBaseUrl);
      const shouldUseGeminiRestFallback =
        looksLikeGeminiModel(fallbackModel) &&
        !!fallbackBaseUrl &&
        isGoogleGenerativeLanguageHost(geminiTarget.baseUrl);
      if (!shouldUseGeminiRestFallback) {
        throw openAiError;
      }

      const apiVersion = shouldUseGeminiAlpha(fallbackModel)
        ? "v1alpha"
        : geminiTarget.apiVersion;
      const restUrl = buildGeminiRestUrl(
        geminiTarget.baseUrl,
        apiVersion || "v1beta",
        fallbackModel
      );
      const requestBody = stringifyJsonAsciiSafe(
        buildGeminiRestBody(prompt, images)
      );
      const requestBodyAsciiLiteral = stringifyJsonAsciiSafe(
        buildGeminiAsciiLiteralBody(prompt, images)
      );

      console.log(
        "[analyze-materials] OpenAI-compatible request failed for Gemini-family model; retrying Gemini REST fallback.",
        {
          model: fallbackModel,
          baseUrl: summarizeBaseUrlForLog(fallbackBaseUrl),
          restUrl: summarizeBaseUrlForLog(restUrl),
        }
      );

      try {
        let restResponse = await serverRequestTextWithRetry(
          restUrl,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": apiKey,
              Connection: "close",
            },
            body: requestBody,
            cache: "no-store",
          },
          {
            retries: 3,
            retryDelayMs: 2500,
            timeoutMs: ANALYZE_REQUEST_TIMEOUT_MS,
          }
        );

        if (
          (restResponse.status < 200 || restResponse.status >= 300) &&
          isAsciiCodecError(restResponse.text) &&
          containsNonAsciiText(prompt)
        ) {
          console.log(
            "[analyze-materials] Retrying Gemini REST fallback with ASCII-literal prompt payload.",
            {
              model: fallbackModel,
              baseUrl: summarizeBaseUrlForLog(fallbackBaseUrl),
            }
          );
          restResponse = await serverRequestTextWithRetry(
            restUrl,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": apiKey,
                Connection: "close",
              },
              body: requestBodyAsciiLiteral,
              cache: "no-store",
            },
            {
              retries: 3,
              retryDelayMs: 2500,
              timeoutMs: ANALYZE_REQUEST_TIMEOUT_MS,
            }
          );
        }

        if (restResponse.status < 200 || restResponse.status >= 300) {
          const detail = extractRemoteErrorText(restResponse.text);
          throw new Error(detail || `Gemini request failed (${restResponse.status})`);
        }

        const restData = parseJsonLikeText(restResponse.text);
        const fallbackText = extractGeminiText(restData);
        if (!fallbackText) {
          throw new Error("AI 返回内容为空，请更换模型或稍后重试。");
        }

        return fallbackText;
      } catch (geminiFallbackError) {
        recordFailureLog({
          provider: "openai",
          operation: "gemini.generateContent.rest (analyze-materials-openai-fallback)",
          url: restUrl,
          status: null,
          requestBody: {
            model: fallbackModel,
            promptLength: prompt.length,
            imagesCount: images.length,
          },
          responseBody:
            geminiFallbackError instanceof Error
              ? geminiFallbackError.message
              : String(geminiFallbackError || ""),
        });

        const openAiMessage = formatAsciiCodecCompatMessage(
          openAiError instanceof Error ? openAiError.message : String(openAiError || "")
        );
        const geminiMessage = formatAsciiCodecCompatMessage(
          geminiFallbackError instanceof Error
            ? geminiFallbackError.message
            : String(geminiFallbackError || "")
        );

        if (geminiMessage && geminiMessage !== openAiMessage) {
          throw new Error(
            `OpenAI 兼容请求失败：${openAiMessage}；Gemini REST 回退也失败：${geminiMessage}`
          );
        }
        throw openAiError;
      }
    });

    return NextResponse.json({ text }, { headers: noStoreHeaders() });
  } catch (error) {
    const message = formatAsciiCodecCompatMessage(
      error instanceof Error ? error.message : "Failed to analyze materials."
    );
    console.error("[analyze-materials] Error:", message);
    return NextResponse.json(
      { error: message },
      { status: 500, headers: noStoreHeaders() }
    );
  }
}
