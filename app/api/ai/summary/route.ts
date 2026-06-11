import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import {
  defaultGeminiTextModel,
  defaultOpenAiTextModel,
  defaultOpenAiVisionModel,
  defaultOpenAiAuthHeader,
  buildOpenAiHeaders,
  normalizeOpenAiAuthHeader,
  normalizeGeminiBaseUrl,
  noStoreHeaders,
  normalizeOpenAiBaseUrl,
} from "@/lib/ai";
import { resolveBuiltInWithCatalog, rewriteUpstreamError } from "@/lib/built-in-api-service/catalog-resolver";
import { recordFailureLog } from "@/lib/diagnostics";
// 🔧 FIX (2026-06-11 S-2/BUG-D1): reasoning 模型防护执行器（三件套 + 兼容回退）
import { executeOpenAiChatWithCompatRetries } from "@/lib/network/openai-chat-attempt";
import type { InlineImage } from "@/lib/ai";
import type { BuiltInServiceCategory } from "@/lib/built-in-api-service/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 🔧 FIX (2026-06-11 maxDuration): 60 → 300。Render 忽略该字段；Vercel 形态下
//   reasoning 模型/带图理解常超 60s，避免被平台截断。
export const maxDuration = 300;

// 🔧 FIX (2026-06-11 BUG-D7): [DEBUG] 日志包进 DEBUG_AI_ROUTES=1 开关，
//   生产环境默认静默，避免刷屏并泄漏请求元数据。
const debugLog = (...args: unknown[]) => {
  if (process.env.DEBUG_AI_ROUTES === "1") console.log(...args);
};

const shouldUseGeminiAlpha = (model: string) =>
  /preview|exp|experimental|alpha/i.test(model);

const toInlinePart = (img: InlineImage) => ({
  inlineData: { mimeType: img.mimeType, data: img.data },
});

// 🔧 FIX (2026-05-07): 视频脚本生成是带图请求，前端已通过 requestKind="script"
//   + requireImageGrounding=true 表态需要图像理解。但 admin-panel 这条路由原本
//   硬编码 category="text"，结果用 catalog 里 text 分类的 apiKey/baseUrl/model
//   去打上游图像理解请求，导致 `public API key required` / 模型不支持等错误。
//   改为根据请求形态动态选 category：
//     - 脚本/图像理解（带图） → vision，缺则退到 multimodal；禁止退 text
//     - 纯文本 prompt → text
const VALID_BUILT_IN_CATEGORIES: BuiltInServiceCategory[] = [
  "multimodal",
  "text",
  "image",
  "vision",
  "tts",
  "video",
];

const pickBuiltInCategoryForSummary = (body: any): BuiltInServiceCategory => {
  const explicit = (body?.category || body?.builtInCategory || "")
    .toString()
    .trim()
    .toLowerCase();
  if (
    explicit &&
    (VALID_BUILT_IN_CATEGORIES as string[]).includes(explicit)
  ) {
    return explicit as BuiltInServiceCategory;
  }
  const hasImages = Array.isArray(body?.images) && body.images.length > 0;
  const isScript =
    body?.requestKind === "script" ||
    body?.requireImageGrounding === true ||
    body?.requireImages === true;
  if (hasImages || isScript) return "vision";
  return "text";
};

const resolveBuiltInConfigForSummary = async (
  userId: string,
  body: any
) => {
  const primaryCategory = pickBuiltInCategoryForSummary(body);
  const fallbackOrder: BuiltInServiceCategory[] =
    primaryCategory === "vision"
      ? ["vision", "multimodal"]
      : primaryCategory === "multimodal"
        ? ["multimodal", "vision"]
        : [primaryCategory];
  // 🔧 FIX (2026-06-11 BUG-D2): 把用户所选模型透传给 catalog 解析器。
  //   带图请求走 vision 模型字段，纯文本走 text 模型字段（与下游 model 选择逻辑一致）。
  const hasImages = Array.isArray(body?.images) && body.images.length > 0;
  const requestedModel = (
    (hasImages ? body?.openAiVisionModel : body?.openAiTextModel) || ""
  )
    .toString()
    .trim();
  for (const category of fallbackOrder) {
    const resolved = await resolveBuiltInWithCatalog(userId, category, requestedModel);
    if (resolved && resolved.apiKey && resolved.baseUrl) {
      return { config: resolved, category };
    }
  }
  return { config: null, category: primaryCategory };
};

export async function POST(req: Request) {
  try {
    const body = await req.json();
    let provider =
      body.provider === "openai"
        ? "openai"
        : body.provider === "gemini_compat"
          ? "gemini_compat"
          : "gemini";
    let apiKey = (body.apiKey || "").trim();
    const useBuiltInService = body.useBuiltInService === true;
    const userId = (body.userId || "").trim();
    const prompt = (body.prompt || "").trim();
    const images = Array.isArray(body.images)
      ? (body.images as InlineImage[])
      : [];

    // Debug logging（🔧 FIX 2026-06-11 BUG-D7: 仅 DEBUG_AI_ROUTES=1 时输出）
    debugLog("[DEBUG /api/ai/summary] Request received:", {
      provider,
      apiKey: apiKey ? `***${apiKey.slice(-4)}` : "EMPTY",
      useBuiltInService,
      userId,
      promptLength: prompt.length,
      imagesCount: images.length,
      condition_check: {
        not_apiKey: !apiKey,
        useBuiltInService,
        has_userId: !!userId,
        will_resolve: !apiKey && useBuiltInService && userId
      }
    });

    const builtInResolution =
      !apiKey && useBuiltInService && userId
        ? await resolveBuiltInConfigForSummary(userId, body)
        : { config: null, category: pickBuiltInCategoryForSummary(body) };
    const builtInConfig = builtInResolution.config;
    const resolvedCategory = builtInResolution.category;

    debugLog("[DEBUG /api/ai/summary] Built-in config resolved:", {
      hasConfig: !!builtInConfig,
      configApiKey: builtInConfig?.apiKey ? `***${builtInConfig.apiKey.slice(-4)}` : "NONE",
      configBaseUrl: builtInConfig?.baseUrl,
      configModel: builtInConfig?.model,
      resolvedCategory,
      requestedCategory:
        (body?.category || body?.builtInCategory || "").toString().trim() || null,
      requestKind: body?.requestKind || null,
      requireImageGrounding: body?.requireImageGrounding === true,
    });

    if (builtInConfig) {
      apiKey = builtInConfig.apiKey;
      provider = "openai";
      debugLog("[DEBUG /api/ai/summary] Using built-in config, provider set to:", provider);
    }

    debugLog("[DEBUG /api/ai/summary] Final validation:", {
      hasApiKey: !!apiKey,
      hasPrompt: !!prompt,
      willPass: !!(apiKey && prompt)
    });

    if (!apiKey || !prompt) {
      debugLog("[DEBUG /api/ai/summary] Validation failed! Returning 400 error");
      return NextResponse.json(
        { error: "Missing apiKey or prompt." },
        { status: 400, headers: noStoreHeaders() }
      );
    }

    if (provider === "gemini" || provider === "gemini_compat") {
      const geminiTextModel =
        (body.geminiTextModel || "").trim() || defaultGeminiTextModel;
      const geminiCompat =
        provider === "gemini_compat"
          ? normalizeGeminiBaseUrl(body.geminiCompatBaseUrl)
          : null;
      const apiVersion = shouldUseGeminiAlpha(geminiTextModel)
        ? "v1alpha"
        : geminiCompat?.apiVersion;
      const ai = new GoogleGenAI({
        apiKey,
        ...(apiVersion ? { apiVersion } : {}),
        ...(geminiCompat
          ? { httpOptions: { baseUrl: geminiCompat.baseUrl, apiVersion } }
          : {}),
      });
      const contents = images.length
        ? { parts: [{ text: prompt }, ...images.map(toInlinePart)] }
        : prompt;
      const response = await ai.models.generateContent({
        model: geminiTextModel,
        contents,
      });
      return NextResponse.json(
        { text: response.text || "" },
        { headers: noStoreHeaders() }
      );
    }

    const baseUrl = normalizeOpenAiBaseUrl(
      builtInConfig?.baseUrl || body.openAiBaseUrl
    );
    const openAiAuthHeader = normalizeOpenAiAuthHeader(body.openAiAuthHeader);
    // 🔧 FIX (2026-05-07): 当解析到 builtInConfig 时，apiKey/baseUrl 都已被强制
    //   切换到内置网关；如果仍允许 vision/text model 来自前端 body，会出现「内置
    //   API Key + 内置 baseUrl + 用户随手配置的 gpt-5.4」这种致命错配。授权用户
    //   走内置时 model 也必须用 builtInConfig.model。
    const builtInModel = (builtInConfig?.model || "").trim();
    const model = builtInModel
      ? builtInModel
      : (body.openAiTextModel || "").trim() || defaultOpenAiTextModel;
    const visionModel = builtInModel
      ? builtInModel
      : (body.openAiVisionModel || "").trim() || model || defaultOpenAiVisionModel;

    // 🔧 FIX (2026-06-11 S-2/BUG-D1): 原实现裸 fetch + temperature:0.6 + 无输出上限 + 非流式，
    // reasoning 模型（gpt-5.x/o系列/gemini-3.x）必踩 400 或 CF 524。改走统一执行器：
    // 自动选 max_completion_tokens / 跳过 temperature / 流式优先 + 三类兼容回退。
    const result = await executeOpenAiChatWithCompatRetries({
      url: `${baseUrl}/chat/completions`,
      headers: {
        ...buildOpenAiHeaders(apiKey, true, openAiAuthHeader),
      },
      model: images.length ? visionModel : model,
      temperature: 0.6,
      maxOutputTokens: Number(body.maxTokens) > 0 ? Number(body.maxTokens) : undefined,
      messages: [
        { role: "system", content: "Answer plainly without extra markup." },
        images.length
          ? {
              role: "user",
              content: [
                { type: "text", text: prompt },
                ...images.map((img) => ({
                  type: "image_url",
                  image_url: {
                    url: `data:${img.mimeType};base64,${img.data}`,
                  },
                })),
              ],
            }
          : { role: "user", content: prompt },
      ],
    });

    if (!result.res.ok) {
      recordFailureLog({
        provider,
        operation: result.operation,
        url: result.url,
        status: result.res.status,
        requestBody: {
          model: images.length ? visionModel : model,
          maxOutputTokens: result.maxOutputTokens,
          reasoningLike: result.reasoningLike,
          messages: images.length ? "[image+text]" : "text",
        },
        responseBody: result.rawText,
      });
      return NextResponse.json(
        { error: rewriteUpstreamError(result.res.status, result.rawText || "OpenAI-compatible request failed.", resolvedCategory) },
        { status: result.res.status, headers: noStoreHeaders() }
      );
    }

    const text = result.text;
    return NextResponse.json({ text }, { headers: noStoreHeaders() });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to generate summary.";
    const errorCause =
      error instanceof Error && "cause" in error
        ? (error as { cause?: unknown }).cause
        : undefined;
    const cause = errorCause ? ` ${String(errorCause)}` : "";
    return NextResponse.json(
      { error: `${message}${cause}`.trim() },
      { status: 500, headers: noStoreHeaders() }
    );
  }
}
