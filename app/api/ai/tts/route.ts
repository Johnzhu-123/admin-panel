import { NextRequest, NextResponse } from "next/server";
import {
  buildOpenAiHeaders,
  normalizeOpenAiAuthHeader,
  resolveOpenAiEndpoint,
} from "@/lib/ai";
import type { TTSRequest, TTSResponse } from "@/lib/tts-service/types";
import { injectBuiltInCategoryConfig } from "@/lib/built-in-api-service/apply-cloud-config";

export const maxDuration = 900;
const DEFAULT_INDEXTTS2_SERVICE_URL = "http://127.0.0.1:7860";
const DEFAULT_OPENAI_TTS_MODEL = "tts-1";
const DEFAULT_OPENAI_TTS_VOICE = "alloy";

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

const resolveIndextts2ServiceUrl = (serviceUrl?: string) => {
  const explicitUrl =
    typeof serviceUrl === "string" ? serviceUrl.trim() : "";
  return explicitUrl || DEFAULT_INDEXTTS2_SERVICE_URL;
};

const resolveCloudBaseUrl = (baseUrl?: string) =>
  typeof baseUrl === "string" ? baseUrl.trim() : "";

async function recordBuiltInTtsUsage(
  body: Record<string, unknown>,
  success: boolean,
  startedAt: number,
  error?: string
) {
  if (body?.useBuiltInService !== true) return;
  const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
  if (!userId) return;
  try {
    const { recordUsageToDatabase } = await import("@/lib/built-in-api-service/db");
    await recordUsageToDatabase(
      `tts_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      userId,
      "tts/default",
      success,
      Math.max(1, Date.now() - startedAt),
      error
    );
  } catch (usageError) {
    console.error("[TTS API] failed to record usage:", usageError);
  }
}

const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

const resolveOpenAiSpeechEndpoint = (baseUrl: string) => {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (/\/audio\/speech$/i.test(trimmed)) return trimmed;
  return resolveOpenAiEndpoint(trimmed, "/audio/speech");
};

async function parseOpenAiCompatibleAudioResponse(
  response: Response
): Promise<TTSResponse> {
  const contentType = response.headers.get("content-type") || "";
  if (/application\/json/i.test(contentType)) {
    const data = await response.json().catch(() => ({}));
    const jsonAudio =
      data?.audioBase64 ||
      data?.audio ||
      data?.data?.audioBase64 ||
      data?.data?.audio ||
      data?.data?.[0]?.b64_json ||
      data?.data?.[0]?.audio;
    if (typeof jsonAudio === "string" && jsonAudio) {
      return {
        audioBase64: jsonAudio,
        format: typeof data?.format === "string" ? data.format : "wav",
      };
    }
    throw new Error("云端 TTS 未返回可用音频数据");
  }

  const arrayBuffer = await response.arrayBuffer();
  if (!arrayBuffer.byteLength) {
    throw new Error("云端 TTS 返回了空音频数据");
  }
  return {
    audioBase64: arrayBufferToBase64(arrayBuffer),
    format: /mpeg|mp3/i.test(contentType) ? "mp3" : "wav",
  };
}

async function synthesizeWithOpenAiCompatibleTts(
  request: TTSRequest,
  options: {
    apiKey: string;
    baseUrl: string;
    authHeader?: string;
  }
): Promise<TTSResponse> {
  const endpointUrl = resolveOpenAiSpeechEndpoint(options.baseUrl);
  const res = await fetch(endpointUrl, {
    method: "POST",
    headers: {
      ...buildOpenAiHeaders(
        options.apiKey,
        true,
        normalizeOpenAiAuthHeader(options.authHeader)
      ),
    },
    body: JSON.stringify({
      model: request.model || DEFAULT_OPENAI_TTS_MODEL,
      input: request.text,
      voice: request.voice || DEFAULT_OPENAI_TTS_VOICE,
      speed: request.speed,
    }),
    signal: AbortSignal.timeout(300000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `云端 TTS 失败: ${res.status}${detail ? ` ${detail}` : ""}`
    );
  }

  return parseOpenAiCompatibleAudioResponse(res);
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  let bodyForUsage: Record<string, unknown> = {};
  try {
    let body = await request.json();
    bodyForUsage = body as Record<string, unknown>;

    // admin-panel 端：useBuiltInService=true 时从 catalog 注入 baseUrl/apiKey/model
    if (body?.useBuiltInService === true) {
      const { body: enriched, applied } = await injectBuiltInCategoryConfig(
        body as Record<string, unknown>,
        "tts"
      );
      if (applied) {
        body = enriched;
        bodyForUsage = body as Record<string, unknown>;
      } else {
        await recordBuiltInTtsUsage(bodyForUsage, false, startedAt, "TTS 服务未在管理后台启用或配置");
        return NextResponse.json(
          { error: "TTS 服务未在管理后台启用或配置" },
          { status: 503 }
        );
      }
    }

    const {
      text,
      model,
      voice,
      speed,
      referenceAudioBase64,
      emotionControlMethod,
      emotionRefAudioBase64,
      emotionWeight,
      emotionVectors,
      emotionText,
      emotionRandom,
      temperature,
      topP,
      topK,
      maxTextTokensPerSegment,
      doSample,
      lengthPenalty,
      numBeams,
      repetitionPenalty,
      maxMelTokens,
      geminiVoiceName,
      provider,
      serviceUrl,
      apiKey,
      baseUrl,
      openAiAuthHeader,
    } = body;

    if (!text?.trim()) {
      await recordBuiltInTtsUsage(bodyForUsage, false, startedAt, "缺少文本内容");
      return NextResponse.json(
        { error: "缺少文本内容" },
        { status: 400 }
      );
    }

    if ((provider || "indextts2") === "indextts2" && !referenceAudioBase64) {
      await recordBuiltInTtsUsage(
        bodyForUsage,
        false,
        startedAt,
        "index-tts2 缺少音色参考音频"
      );
      return NextResponse.json(
        {
          error:
            "index-tts2 需要先上传音色参考音频。请到“配音设置 > 配音高级设置”中上传后再生成配音。",
        },
        { status: 400 }
      );
    }

    const ttsRequest: TTSRequest = {
      text,
      model,
      voice,
      speed,
      referenceAudioBase64,
      emotionControlMethod,
      emotionRefAudioBase64,
      emotionWeight,
      emotionVectors,
      emotionText,
      emotionRandom,
      temperature,
      topP,
      topK,
      maxTextTokensPerSegment,
      doSample,
      lengthPenalty,
      numBeams,
      repetitionPenalty,
      maxMelTokens,
      geminiVoiceName,
    };

    if (provider === "gemini") {
      const { GeminiTTSClient } = await import(
        "@/lib/tts-service/gemini-tts-client"
      );
      const key = apiKey || process.env.GEMINI_API_KEY || "";
      const geminiBaseUrl =
        resolveCloudBaseUrl(baseUrl) || process.env.GEMINI_BASE_URL || undefined;
      const client = new GeminiTTSClient(key, geminiBaseUrl, model);
      const result = await client.synthesize(ttsRequest);
      console.log("[TTS API] success", {
        provider: "gemini",
        model: model || "gemini-2.5-flash-preview-tts",
        textLength: text.length,
        elapsedMs: Date.now() - startedAt,
      });
      await recordBuiltInTtsUsage(bodyForUsage, true, startedAt);
      return NextResponse.json(result);
    }

    if (provider === "openai") {
      const resolvedBaseUrl = resolveCloudBaseUrl(baseUrl);
      if (!resolvedBaseUrl) {
        await recordBuiltInTtsUsage(bodyForUsage, false, startedAt, "云端 TTS 缺少 Base URL");
        return NextResponse.json(
          { error: "云端 TTS 缺少 Base URL" },
          { status: 400 }
        );
      }
      if (!apiKey?.trim()) {
        await recordBuiltInTtsUsage(bodyForUsage, false, startedAt, "云端 TTS 缺少 API Key");
        return NextResponse.json(
          { error: "云端 TTS 缺少 API Key" },
          { status: 400 }
        );
      }
      if (!model?.trim()) {
        await recordBuiltInTtsUsage(bodyForUsage, false, startedAt, "云端 TTS 缺少模型");
        return NextResponse.json(
          { error: "云端 TTS 缺少模型" },
          { status: 400 }
        );
      }

      const result = await synthesizeWithOpenAiCompatibleTts(ttsRequest, {
        apiKey: apiKey.trim(),
        baseUrl: resolvedBaseUrl,
        authHeader: openAiAuthHeader,
      });
      console.log("[TTS API] success", {
        provider: "openai",
        model,
        textLength: text.length,
        elapsedMs: Date.now() - startedAt,
      });
      await recordBuiltInTtsUsage(bodyForUsage, true, startedAt);
      return NextResponse.json(result);
    }

    const { IndexTTSClient } = await import(
      "@/lib/tts-service/index-tts-client"
    );
    const resolvedUrl = resolveIndextts2ServiceUrl(serviceUrl);
    const client = new IndexTTSClient(resolvedUrl);
    const result = await client.synthesize(ttsRequest);
    console.log("[TTS API] success", {
      provider: "indextts2",
      serviceUrl: resolvedUrl,
      textLength: text.length,
      hasReferenceAudio: !!referenceAudioBase64,
      elapsedMs: Date.now() - startedAt,
    });
    await recordBuiltInTtsUsage(bodyForUsage, true, startedAt);
    return NextResponse.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "TTS 合成失败";
    const isTimeout = message.includes("timeout") || message.includes("aborted");
    console.error("[TTS API]", message, {
      elapsedMs: Date.now() - startedAt,
    });
    await recordBuiltInTtsUsage(bodyForUsage, false, startedAt, message);
    return NextResponse.json(
      {
        error: isTimeout
          ? `TTS 服务超时：${message}。请检查服务是否可用。`
          : message,
      },
      { status: isTimeout ? 504 : 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  const serviceUrl = request.nextUrl.searchParams.get("serviceUrl") || "";
  const provider =
    request.nextUrl.searchParams.get("provider") || "indextts2";
  const apiKey = request.nextUrl.searchParams.get("apiKey") || "";
  const baseUrl = request.nextUrl.searchParams.get("baseUrl") || "";
  const model = request.nextUrl.searchParams.get("model") || "";

  try {
    if (provider === "gemini") {
      const { GeminiTTSClient } = await import(
        "@/lib/tts-service/gemini-tts-client"
      );
      const client = new GeminiTTSClient(
        apiKey || process.env.GEMINI_API_KEY || "",
        resolveCloudBaseUrl(baseUrl) || process.env.GEMINI_BASE_URL || undefined,
        model || undefined
      );
      const status = await client.checkStatus();
      return NextResponse.json(status);
    }

    if (provider === "openai") {
      if (!apiKey.trim()) {
        return NextResponse.json({
          running: false,
          provider: "openai",
          message: "未配置云端 TTS API Key",
        });
      }
      if (!baseUrl.trim()) {
        return NextResponse.json({
          running: false,
          provider: "openai",
          message: "未配置云端 TTS Base URL",
        });
      }
      if (!model.trim()) {
        return NextResponse.json({
          running: false,
          provider: "openai",
          message: "未选择云端 TTS 模型",
        });
      }
      return NextResponse.json({
        running: true,
        modelLoaded: true,
        provider: "openai",
        message: `云端 TTS 已就绪 (${model})`,
      });
    }

    const { IndexTTSClient } = await import(
      "@/lib/tts-service/index-tts-client"
    );
    const resolvedUrl = resolveIndextts2ServiceUrl(serviceUrl);
    const client = new IndexTTSClient(resolvedUrl);
    const status = await client.checkStatus();
    return NextResponse.json(status);
  } catch (err) {
    return NextResponse.json(
      {
        running: false,
        message:
          err instanceof Error ? err.message : "状态检查失败",
      },
      { status: 500 }
    );
  }
}
