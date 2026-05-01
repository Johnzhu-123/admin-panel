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
import { getBuiltInAPIService } from "@/lib/built-in-api-service";
import { getBuiltInServiceConfig } from "@/lib/built-in-api-service/config";
import { recordFailureLog } from "@/lib/diagnostics";
import { enhanceOpenAICompatibility } from "@/lib/api-compatibility/integration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

const resolveBuiltInTextConfig = async (userId: string) => {
  try {
    console.log("[DEBUG resolveBuiltInTextConfig] Starting for userId:", userId);
    
    const builtInService = getBuiltInAPIService();
    await builtInService.initialize();
    console.log("[DEBUG resolveBuiltInTextConfig] Service initialized");

    const isAuthorized = await builtInService.checkUserAuthorization(userId);
    console.log("[DEBUG resolveBuiltInTextConfig] User authorized:", isAuthorized);
    if (!isAuthorized) return null;

    const services = await builtInService.getAvailableServices(userId);
    console.log("[DEBUG resolveBuiltInTextConfig] Available services:", services.map(s => ({
      id: s.id,
      isBuiltIn: s.isBuiltIn,
      isAvailable: s.isAvailable
    })));
    
    const builtInOption = services.find(
      (service) => service.isBuiltIn && service.isAvailable
    );
    console.log("[DEBUG resolveBuiltInTextConfig] Built-in option found:", !!builtInOption);
    if (!builtInOption) return null;

    const config = getBuiltInServiceConfig(builtInOption.id);
    console.log("[DEBUG resolveBuiltInTextConfig] Config retrieved:", {
      hasConfig: !!config,
      apiKey: config?.apiKey ? `***${config.apiKey.slice(-4)}` : "NONE",
      baseUrl: config?.baseUrl,
      model: config?.model
    });
    
    return config;
  } catch (error) {
    console.error("[DEBUG resolveBuiltInTextConfig] Error:", error);
    return null;
  }
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

    // Debug logging
    console.log("[DEBUG /api/ai/plan] Request received:", {
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
        ? await resolveBuiltInTextConfig(userId)
        : null;

    console.log("[DEBUG /api/ai/plan] Built-in config resolved:", {
      hasConfig: !!builtInConfig,
      configApiKey: builtInConfig?.apiKey ? `***${builtInConfig.apiKey.slice(-4)}` : "NONE",
      configBaseUrl: builtInConfig?.baseUrl,
      configModel: builtInConfig?.model
    });

    if (builtInConfig) {
      apiKey = builtInConfig.apiKey;
      provider = "openai";
      console.log("[DEBUG /api/ai/plan] Using built-in config, provider set to:", provider);
    }

    console.log("[DEBUG /api/ai/plan] Final validation:", {
      hasApiKey: !!apiKey,
      hasPrompt: !!prompt,
      willPass: !!(apiKey && prompt)
    });

    if (!apiKey || !prompt) {
      console.error("[DEBUG /api/ai/plan] Validation failed! Returning 400 error");
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

    // Enhanced request with compatibility handling
    const requestConfig = {
      url: `${baseUrl}/chat/completions`,
      method: "POST",
      headers: {
        ...buildOpenAiHeaders(apiKey, true, openAiAuthHeader),
      },
      body: {
        model,
        temperature: 0.6,
        messages: [
          {
            role: "system",
            content: "You are a helpful assistant that creates presentation outlines. Return only valid JSON that matches the requested schema. Do not include any markdown formatting or additional text outside the JSON.",
          },
          { role: "user", content: prompt },
        ],
      },
    };

    // Apply compatibility enhancements
    const enhancedConfig = await enhanceOpenAICompatibility(requestConfig, {
      provider: provider,
      baseUrl: baseUrl,
      operation: 'chat/completions'
    });

    const res = await fetch(enhancedConfig.url, {
      method: enhancedConfig.method,
      headers: enhancedConfig.headers,
      body: JSON.stringify(enhancedConfig.body),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      
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
        operation: "chat/completions",
        url: enhancedConfig.url,
        status: res.status,
        requestBody: {
          model,
          temperature: 0.6,
          messages: "text",
        },
        responseBody: detail,
      });
      
      return NextResponse.json(
        { error: errorMessage },
        { status: res.status, headers: noStoreHeaders() }
      );
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || "";
    
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
