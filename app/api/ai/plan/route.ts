import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import {
  defaultGeminiTextModel,
  defaultOpenAiTextModel,
  defaultOpenAiAuthHeader,
  buildOpenAiHeaders,
  normalizeOpenAiAuthHeader,
  normalizeGeminiBaseUrl,
  noStoreHeaders,
  normalizeOpenAiBaseUrl,
  parseJsonFromText,
} from "@/lib/ai";
import { resolveBuiltInWithCatalog, rewriteUpstreamError } from "@/lib/built-in-api-service/catalog-resolver";
import { recordFailureLog } from "@/lib/diagnostics";
import { enhanceOpenAICompatibility } from "@/lib/api-compatibility/integration";
// 🔧 FIX (2026-06-11 S-2/BUG-D1): reasoning 模型防护执行器（三件套 + 兼容回退）
import { executeOpenAiChatWithCompatRetries } from "@/lib/network/openai-chat-attempt";
import {
  requireClaimedServicePrincipal,
  ServicePrincipalError,
} from "@/lib/auth/service-principal";
import {
  BuiltInQuotaError,
  runWithBuiltInQuota,
} from "@/lib/built-in-api-service/legacy-quota";
import { fetchPublicHttpUrl } from "@/lib/network/public-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 🔧 FIX (2026-06-11 maxDuration): 60 → 300。Render 忽略该字段；Vercel 形态下
//   reasoning 模型/长 deck 生成常超 60s，避免被平台截断。
export const maxDuration = 300;

// 🔧 FIX (2026-06-11 BUG-D7): [DEBUG] 日志包进 DEBUG_AI_ROUTES=1 开关，
//   生产环境默认静默，避免刷屏并泄漏请求元数据。
const debugLog = (...args: unknown[]) => {
  if (process.env.DEBUG_AI_ROUTES === "1") console.log(...args);
};

const shouldUseGeminiAlpha = (model: string) =>
  /preview|exp|experimental|alpha/i.test(model);

const generateGeminiJson = async (
  ai: GoogleGenAI,
  model: string,
  prompt: string
) => {
  try {
    return await ai.models.generateContent({
      model,
      contents: prompt,
      config: { responseMimeType: "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "");
    const shouldRetry =
      message.includes("responseMimeType") ||
      message.includes("response mime type") ||
      message.includes("INVALID_ARGUMENT");
    if (!shouldRetry) throw error;
    return await ai.models.generateContent({
      model,
      contents: prompt,
    });
  }
};

// 🔧 FIX (2026-06-11 BUG-D2): 把用户请求的文本模型透传给 catalog 解析器，
//   命中 subtask.model/models[] 时不再被默认模型覆盖。
const resolveBuiltInTextConfig = (userId: string, requestedModel?: string) =>
  resolveBuiltInWithCatalog(userId, "text", requestedModel);

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
    let userId = (body.userId || "").trim();
    if (useBuiltInService) {
      const principal = await requireClaimedServicePrincipal(req, userId);
      userId = principal.resolvedUserId || userId || principal.email || principal.userId;
    }
    const prompt = (body.prompt || "").trim();

    // Debug logging（🔧 FIX 2026-06-11 BUG-D7: 仅 DEBUG_AI_ROUTES=1 时输出）
    debugLog("[DEBUG /api/ai/plan] Request received:", {
      provider,
      apiKey: apiKey ? `***${apiKey.slice(-4)}` : "EMPTY",
      useBuiltInService,
      userId,
      promptLength: prompt.length,
      condition_check: {
        not_apiKey: !apiKey,
        useBuiltInService,
        has_userId: !!userId,
        will_resolve: !apiKey && useBuiltInService && userId
      }
    });

    const builtInConfig =
      !apiKey && useBuiltInService && userId
        ? await resolveBuiltInTextConfig(
            userId,
            // 🔧 FIX (2026-06-11 BUG-D2): 透传用户所选模型
            String(body.openAiTextModel || body.model || "").trim()
          )
        : null;

    debugLog("[DEBUG /api/ai/plan] Built-in config resolved:", {
      hasConfig: !!builtInConfig,
      configApiKey: builtInConfig?.apiKey ? `***${builtInConfig.apiKey.slice(-4)}` : "NONE",
      configBaseUrl: builtInConfig?.baseUrl,
      configModel: builtInConfig?.model
    });

    if (builtInConfig) {
      apiKey = builtInConfig.apiKey;
      provider = "openai";
      debugLog("[DEBUG /api/ai/plan] Using built-in config, provider set to:", provider);
    }

    debugLog("[DEBUG /api/ai/plan] Final validation:", {
      hasApiKey: !!apiKey,
      hasPrompt: !!prompt,
      willPass: !!(apiKey && prompt)
    });

    if (!apiKey || !prompt) {
      debugLog("[DEBUG /api/ai/plan] Validation failed! Returning 400 error");
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
      const response = await generateGeminiJson(ai, geminiTextModel, prompt);
      const parsed = parseJsonFromText(response.text || "");
      return NextResponse.json(
        { slides: Array.isArray(parsed.slides) ? parsed.slides : [] },
        { headers: noStoreHeaders() }
      );
    }

    const baseUrl = normalizeOpenAiBaseUrl(
      builtInConfig?.baseUrl || body.openAiBaseUrl
    );
    const openAiAuthHeader = normalizeOpenAiAuthHeader(body.openAiAuthHeader);
    const model =
      (builtInConfig?.model || body.openAiTextModel || "").trim() ||
      defaultOpenAiTextModel;

    // 🔧 FIX (2026-06-11 S-2/BUG-D1): 原实现硬编码 temperature:0.6、无输出上限、非流式、裸 fetch。
    // 改走统一执行器：reasoning 模型自动 max_completion_tokens / 跳过 temperature / 流式防 524，
    // 并显式输出预算（缺省 reasoning 16000 / 普通 8192）防长 deck JSON 截断。
    const result = await executeOpenAiChatWithCompatRetries({
      url: `${baseUrl}/chat/completions`,
      headers: {
        ...buildOpenAiHeaders(apiKey, true, openAiAuthHeader),
      },
      model,
      request: builtInConfig
        ? (url, init) =>
            runWithBuiltInQuota({
              userId,
              serviceId: builtInConfig.id,
              dispatch: () =>
                fetchPublicHttpUrl(url, init, {
                  description: "Built-in plan endpoint",
                  allowHttp:
                    process.env.MD2PPT_ALLOW_PRIVATE_API_PROXY === "1",
                  allowPrivateNetwork:
                    process.env.MD2PPT_ALLOW_PRIVATE_API_PROXY === "1",
                  maxRedirects: 0,
                }),
            })
        : undefined,
      temperature: 0.6,
      maxOutputTokens: Number(body.maxTokens) > 0 ? Number(body.maxTokens) : undefined,
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant that creates presentation outlines. Return only valid JSON that matches the requested schema. Do not include any markdown formatting or additional text outside the JSON.",
        },
        { role: "user", content: prompt },
      ],
      enhance: async (config) => {
        const enhanced = await enhanceOpenAICompatibility(config, {
          provider: provider,
          baseUrl: baseUrl,
          operation: 'chat/completions'
        });
        return {
          url: enhanced.url,
          method: enhanced.method,
          headers: enhanced.headers as Record<string, string>,
          body: enhanced.body as Record<string, unknown>,
        };
      },
    });
    const res = result.res;

    if (!res.ok) {
      const detail = result.rawText;
      
      // Enhanced error handling for common third-party API issues
      let errorMessage = detail;
      let shouldRetry = false;
      
      try {
        const errorData = JSON.parse(detail);
        errorMessage = errorData?.error?.message || errorData?.error || errorData?.message || detail;
        
        // Check for common compatibility issues
        if (res.status === 404 && errorMessage.toLowerCase().includes('not found')) {
          errorMessage = "API endpoint not found. This may be a path compatibility issue with the third-party API.";
        } else if (res.status === 422 && errorMessage.toLowerCase().includes('model')) {
          errorMessage = `Model "${model}" may not be supported by this API provider. Try using a different model name.`;
        } else if (res.status === 400 && errorMessage.toLowerCase().includes('format')) {
          errorMessage = "Request format incompatible with this API provider. The provider may not support all OpenAI-compatible parameters.";
        } else if (res.status === 401 && errorMessage.toLowerCase().includes('unauthorized')) {
          errorMessage = "Authentication failed. Check your API key and authentication method.";
        }
      } catch {
        // Keep original error message if parsing fails
      }

      recordFailureLog({
        provider,
        operation: result.operation,
        url: result.url,
        status: res.status,
        requestBody: {
          model,
          maxOutputTokens: result.maxOutputTokens,
          reasoningLike: result.reasoningLike,
          messages: "text",
        },
        responseBody: detail,
      });

      return NextResponse.json(
        { error: rewriteUpstreamError(res.status, errorMessage, "text") },
        { status: res.status, headers: noStoreHeaders() }
      );
    }

    const text = result.text;
    
    if (!text.trim()) {
      return NextResponse.json(
        { error: "Empty response from API. The model may not support structured output or the prompt may need adjustment." },
        { status: 500, headers: noStoreHeaders() }
      );
    }
    
    const parsed = parseJsonFromText(text);
    
    // Validate the parsed response
    if (!parsed || typeof parsed !== 'object') {
      return NextResponse.json(
        { error: "Invalid JSON response from API. The model may not support structured output." },
        { status: 500, headers: noStoreHeaders() }
      );
    }
    
    // Ensure slides array exists and is valid
    const slides = Array.isArray(parsed.slides) ? parsed.slides : [];
    
    if (slides.length === 0) {
      // Try to extract slides from other possible response formats
      if (Array.isArray(parsed)) {
        return NextResponse.json({ slides: parsed }, { headers: noStoreHeaders() });
      } else if (parsed.data && Array.isArray(parsed.data)) {
        return NextResponse.json({ slides: parsed.data }, { headers: noStoreHeaders() });
      } else if (parsed.result && Array.isArray(parsed.result)) {
        return NextResponse.json({ slides: parsed.result }, { headers: noStoreHeaders() });
      }
    }
    
    return NextResponse.json(
      { slides: slides },
      { headers: noStoreHeaders() }
    );
  } catch (error) {
    if (error instanceof BuiltInQuotaError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status, headers: noStoreHeaders() }
      );
    }
    if (error instanceof ServicePrincipalError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status, headers: noStoreHeaders() }
      );
    }
    const message =
      error instanceof Error ? error.message : "Failed to generate plan.";
    const errorCause =
      error instanceof Error && "cause" in error
        ? (error as { cause?: unknown }).cause
        : undefined;
    const cause = errorCause ? ` ${String(errorCause)}` : "";
    
    // Enhanced error message for debugging
    let enhancedMessage = `${message}${cause}`.trim();
    
    if (message.includes('fetch failed') || message.includes('ECONNRESET')) {
      enhancedMessage = "Network connection failed. Please check your internet connection and API endpoint URL.";
    } else if (message.includes('timeout')) {
      enhancedMessage = "Request timed out. The API provider may be experiencing high load or connectivity issues.";
    } else if (message.includes('JSON')) {
      enhancedMessage = "Failed to parse API response. The API provider may not be fully OpenAI-compatible or may be returning unexpected response format.";
    }
    
    return NextResponse.json(
      { error: enhancedMessage },
      { status: 500, headers: noStoreHeaders() }
    );
  }
}
