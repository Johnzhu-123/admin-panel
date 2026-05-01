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
import { getBuiltInAPIService } from "@/lib/built-in-api-service";
import { getBuiltInServiceConfig } from "@/lib/built-in-api-service/config";
import { recordFailureLog } from "@/lib/diagnostics";
import type { InlineImage } from "@/lib/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const shouldUseGeminiAlpha = (model: string) =>
  /preview|exp|experimental|alpha/i.test(model);

const toInlinePart = (img: InlineImage) => ({
  inlineData: { mimeType: img.mimeType, data: img.data },
});

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
    const images = Array.isArray(body.images)
      ? (body.images as InlineImage[])
      : [];

    // Debug logging
    console.log("[DEBUG /api/ai/summary] Request received:", {
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

    const builtInConfig =
      !apiKey && useBuiltInService && userId
        ? await resolveBuiltInTextConfig(userId)
        : null;

    console.log("[DEBUG /api/ai/summary] Built-in config resolved:", {
      hasConfig: !!builtInConfig,
      configApiKey: builtInConfig?.apiKey ? `***${builtInConfig.apiKey.slice(-4)}` : "NONE",
      configBaseUrl: builtInConfig?.baseUrl,
      configModel: builtInConfig?.model
    });

    if (builtInConfig) {
      apiKey = builtInConfig.apiKey;
      provider = "openai";
      console.log("[DEBUG /api/ai/summary] Using built-in config, provider set to:", provider);
    }

    console.log("[DEBUG /api/ai/summary] Final validation:", {
      hasApiKey: !!apiKey,
      hasPrompt: !!prompt,
      willPass: !!(apiKey && prompt)
    });

    if (!apiKey || !prompt) {
      console.error("[DEBUG /api/ai/summary] Validation failed! Returning 400 error");
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
    const model =
      (builtInConfig?.model || body.openAiTextModel || "").trim() ||
      defaultOpenAiTextModel;
    const visionModel =
      (body.openAiVisionModel || builtInConfig?.model || "").trim() ||
      model ||
      defaultOpenAiVisionModel;

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        ...buildOpenAiHeaders(apiKey, true, openAiAuthHeader),
      },
      body: JSON.stringify({
        model: images.length ? visionModel : model,
        temperature: 0.6,
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
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      recordFailureLog({
        provider,
        operation: "chat/completions",
        url: `${baseUrl}/chat/completions`,
        status: res.status,
        requestBody: {
          model: images.length ? visionModel : model,
          temperature: 0.6,
          messages: images.length ? "[image+text]" : "text",
        },
        responseBody: detail,
      });
      return NextResponse.json(
        { error: detail || "OpenAI-compatible request failed." },
        { status: res.status, headers: noStoreHeaders() }
      );
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || "";
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
