import { NextResponse } from "next/server";
import {
  defaultGeminiBaseUrl,
  defaultOpenAiAuthHeader,
  buildOpenAiHeaders,
  normalizeOpenAiAuthHeader,
  normalizeGeminiBaseUrl,
  normalizeOpenAiBaseUrl,
  noStoreHeaders,
} from "@/lib/ai";
import { recordFailureLog } from "@/lib/diagnostics";
import {
  resolveBuiltInWithCatalog,
  rewriteUpstreamError,
  makeUpstreamTimeout,
} from "@/lib/built-in-api-service/catalog-resolver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const normalizeGeminiName = (name: string) =>
  name.startsWith("models/") ? name.slice("models/".length) : name;

const uniqueSorted = (items: string[]) =>
  Array.from(new Set(items.filter(Boolean))).sort();

const collectStringValues = (
  value: unknown,
  target: string[],
  depth = 0
) => {
  if (value === null || value === undefined || depth > 2) return;
  if (typeof value === "string") {
    target.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectStringValues(entry, target, depth + 1));
    return;
  }
  if (typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach((entry) =>
      collectStringValues(entry, target, depth + 1)
    );
  }
};

const normalizeModelId = (model: any) => {
  const id = model?.id || model?.name || model?.model;
  return typeof id === "string" ? id.trim() : "";
};

const extractModelModalities = (model: any) => {
  const values: string[] = [];
  collectStringValues(model?.modality, values);
  collectStringValues(model?.modalities, values);
  collectStringValues(model?.input_modality, values);
  collectStringValues(model?.output_modality, values);
  collectStringValues(model?.capabilities?.modality, values);
  collectStringValues(model?.capabilities?.modalities, values);
  collectStringValues(model?.capabilities?.input, values);
  collectStringValues(model?.capabilities?.output, values);
  collectStringValues(model?.capabilities?.mode, values);
  collectStringValues(model?.capabilities?.type, values);
  return values
    .map((value) => value.toLowerCase())
    .filter((value) => value.trim());
};

const buildModelHints = (model: any) => {
  const id = normalizeModelId(model);
  const pieces: string[] = [];
  collectStringValues(id, pieces);
  collectStringValues(model?.name, pieces);
  collectStringValues(model?.type, pieces);
  collectStringValues(model?.category, pieces);
  collectStringValues(model?.family, pieces);
  collectStringValues(model?.tags, pieces);
  collectStringValues(model?.labels, pieces);
  const modalities = extractModelModalities(model);
  pieces.push(...modalities);
  const text = pieces.join(" ").toLowerCase();
  const tokens = text.split(/[^a-z0-9]+/i).filter(Boolean);
  return { id, text, tokens, modalities };
};

const hasAnyToken = (tokens: string[], candidates: string[]) =>
  candidates.some((token) => tokens.includes(token));

const hasAnySubstring = (text: string, candidates: string[]) =>
  candidates.some((token) => text.includes(token));

const hasModality = (modalities: string[], candidates: string[]) =>
  modalities.some((value) =>
    candidates.some((token) => value.includes(token))
  );

const classifyGeminiModels = (models: any[]) => {
  const textModels: string[] = [];
  const imageModels: string[] = [];
  const multimodalModels: string[] = [];
  const otherModels: string[] = [];

  for (const model of models) {
    const name = normalizeGeminiName(String(model?.name || model?.id || ""));
    if (!name) continue;
    const methods = Array.isArray(model?.supportedGenerationMethods)
      ? model.supportedGenerationMethods
      : [];
    const hasContent = methods.includes("generateContent");
    const looksLikeImage = /image|imagen/i.test(name);
    const hasImage =
      methods.includes("generateImages") ||
      methods.includes("editImage") ||
      looksLikeImage;
    let classified = false;
    if (hasContent) {
      textModels.push(name);
      multimodalModels.push(name);
      classified = true;
    }
    if (hasImage) {
      imageModels.push(name);
      classified = true;
    }
    if (!classified) {
      otherModels.push(name);
    }
  }

  return {
    textModels: uniqueSorted(textModels),
    imageModels: uniqueSorted(imageModels),
    visionModels: [] as string[],
    multimodalModels: uniqueSorted(multimodalModels),
    otherModels: uniqueSorted(otherModels),
  };
};

const imageTokens = [
  "image",
  "images",
  "img",
  "imggen",
  "img2img",
  "txt2img",
  "t2i",
  "i2i",
  "inpaint",
  "outpaint",
  "dalle",
  "gptimage",
  "gpt-image",
  "sdxl",
  "sd3",
  "stable",
  "diffusion",
  "flux",
  "pixart",
  "kandinsky",
  "midjourney",
  "mj",
  "ideogram",
  "imagen",
  "cogview",
  "kolors",
  "playground",
];

const imageSubstrings = [
  "dall-e",
  "gpt-image",
  "stable-diffusion",
  "sdxl",
  "sd3",
  "flux",
  "pixart",
  "kandinsky",
  "midjourney",
  "ideogram",
  "imagen",
  "cogview",
  "kolors",
];

const visionTokens = [
  "vision",
  "visual",
  "vl",
  "llava",
  "multimodal",
  "omni",
  "gpt-4o",
  "gpt-4.1",
  "gpt-4.5",
  "gpt-4",
  "o1",
  "o3",
];

const isOpenAiImageModel = (hint: ReturnType<typeof buildModelHints>) => {
  if (hasModality(hint.modalities, ["image"])) return true;
  if (hasAnyToken(hint.tokens, imageTokens)) return true;
  return hasAnySubstring(hint.text, imageSubstrings);
};

const isOpenAiEmbeddingModel = (hint: ReturnType<typeof buildModelHints>) =>
  /embedding/i.test(hint.text);

const isOpenAiAudioModel = (hint: ReturnType<typeof buildModelHints>) =>
  /audio|whisper|tts|transcribe|speech/i.test(hint.text);

const isOpenAiModerationModel = (hint: ReturnType<typeof buildModelHints>) =>
  /moderation/i.test(hint.text);

const isOpenAiVisionModel = (hint: ReturnType<typeof buildModelHints>) => {
  if (hasModality(hint.modalities, ["vision", "multimodal", "image"])) return true;
  if (hasAnyToken(hint.tokens, visionTokens)) return true;
  return /vision|vl|multimodal/i.test(hint.text);
};

const classifyOpenAiModels = (models: any[]) => {
  const hintById = new Map<string, ReturnType<typeof buildModelHints>>();
  for (const model of models) {
    const hint = buildModelHints(model);
    if (!hint.id) continue;
    const existing = hintById.get(hint.id);
    if (!existing) {
      hintById.set(hint.id, hint);
    } else {
      hintById.set(hint.id, {
        id: hint.id,
        text: `${existing.text} ${hint.text}`,
        tokens: Array.from(new Set([...existing.tokens, ...hint.tokens])),
        modalities: Array.from(
          new Set([...existing.modalities, ...hint.modalities])
        ),
      });
    }
  }
  const ids = uniqueSorted(Array.from(hintById.keys()));
  const classified = ids.map((id) => {
    const hint = hintById.get(id)!;
    return {
      id,
      isImage: isOpenAiImageModel(hint),
      isVision: isOpenAiVisionModel(hint),
      isEmbedding: isOpenAiEmbeddingModel(hint),
      isAudio: isOpenAiAudioModel(hint),
      isModeration: isOpenAiModerationModel(hint),
    };
  });
  const imageModels = classified.filter((item) => item.isImage).map((item) => item.id);
  const visionModels = classified
    .filter((item) => !item.isImage && item.isVision)
    .map((item) => item.id);
  const otherModels = classified
    .filter((item) => item.isEmbedding || item.isAudio || item.isModeration)
    .map((item) => item.id);
  const textModels = classified
    .filter(
      (item) =>
        !item.isImage && !item.isEmbedding && !item.isAudio && !item.isModeration
    )
    .map((item) => item.id);
  return {
    textModels,
    imageModels,
    visionModels,
    multimodalModels: visionModels,
    otherModels,
  };
};

const parseErrorMessage = (data: any) => {
  if (!data) return "";
  if (typeof data.error === "string") return data.error;
  if (typeof data.error?.message === "string") return data.error.message;
  if (typeof data.message === "string") return data.message;
  return "";
};

const resolveBuiltInModelConfig = (userId: string) =>
  resolveBuiltInWithCatalog(userId, "text");

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

    const builtInConfig =
      useBuiltInService && userId ? await resolveBuiltInModelConfig(userId) : null;
    if (builtInConfig) {
      apiKey = builtInConfig.apiKey;
      provider = "openai";
    }

    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing apiKey." },
        { status: 400, headers: noStoreHeaders() }
      );
    }

    if (provider === "gemini" || provider === "gemini_compat") {
      const baseConfig = normalizeGeminiBaseUrl(
        provider === "gemini_compat"
          ? body.geminiCompatBaseUrl
          : defaultGeminiBaseUrl
      );
      const baseUrl = baseConfig.baseUrl;
      const apiVersion = baseConfig.apiVersion;
      const url = `${baseUrl}/${apiVersion}/models?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const message =
          parseErrorMessage(data) || "Failed to fetch Gemini models.";
        recordFailureLog({
          provider,
          operation: "models",
          url,
          status: res.status,
          responseBody: data,
        });
        return NextResponse.json(
          { error: message },
          { status: res.status, headers: noStoreHeaders() }
        );
      }

      const data = await res.json().catch(() => ({}));
      const models = Array.isArray(data.models) ? data.models : [];
      const result = classifyGeminiModels(models);
      return NextResponse.json(result, { headers: noStoreHeaders() });
    }

    const baseUrl = normalizeOpenAiBaseUrl(
      builtInConfig?.baseUrl || body.openAiBaseUrl
    );
    const openAiAuthHeader = normalizeOpenAiAuthHeader(body.openAiAuthHeader);
    const upstreamTimeout = makeUpstreamTimeout(15000);
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/models`, {
        method: "GET",
        headers: buildOpenAiHeaders(apiKey, false, openAiAuthHeader),
        signal: upstreamTimeout.signal,
      });
    } catch (fetchError: any) {
      upstreamTimeout.cancel();
      const isAbort = fetchError?.name === "AbortError";
      recordFailureLog({
        provider,
        operation: "models",
        url: `${baseUrl}/models`,
        status: isAbort ? 504 : 0,
        responseBody: isAbort ? "upstream-timeout-15s" : String(fetchError),
      });
      return NextResponse.json(
        {
          error: isAbort
            ? `内置服务上游 15 秒内无响应（baseUrl=${baseUrl}）。请在管理面板更换上游或检查网络。`
            : `内置服务上游不可达：${fetchError?.message || fetchError}`,
        },
        { status: 504, headers: noStoreHeaders() }
      );
    }
    upstreamTimeout.cancel();

    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const rawMessage =
          parseErrorMessage(data) ||
          (await res.text().catch(() => "")) ||
          "Failed to fetch OpenAI-compatible models.";
        const message = rewriteUpstreamError(res.status, rawMessage, "text");
      recordFailureLog({
        provider,
        operation: "models",
        url: `${baseUrl}/models`,
        status: res.status,
        responseBody: data || rawMessage,
      });
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        return NextResponse.json(
          {
            textModels: [],
            imageModels: [],
            visionModels: [],
            multimodalModels: [],
            otherModels: [],
            warning: message,
          },
          { headers: noStoreHeaders() }
        );
      }
      return NextResponse.json(
        { error: message },
        { status: res.status, headers: noStoreHeaders() }
      );
    }

    const data = await res.json().catch(() => ({}));
    const models = Array.isArray(data?.data) ? data.data : [];
    const result = classifyOpenAiModels(models);
    return NextResponse.json(result, { headers: noStoreHeaders() });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load models.";
    return NextResponse.json(
      { error: message },
      { status: 500, headers: noStoreHeaders() }
    );
  }
}
