import { NextResponse } from "next/server";
import {
  GoogleGenAI,
  MaskReferenceImage,
  MaskReferenceMode,
  RawReferenceImage,
  StyleReferenceImage,
} from "@google/genai";
import {
  defaultGeminiImageModel,
  defaultGeminiTextModel,
  defaultOpenAiImageModel,
  defaultOpenAiTextModel,
  defaultOpenAiVisionModel,
  defaultOpenAiAuthHeader,
  defaultOpenAiImageEndpointPath,
  defaultOpenAiImageResponseFormat,
  buildOpenAiHeaders,
  normalizeOpenAiAuthHeader,
  normalizeGeminiBaseUrl,
  normalizeOpenAiBaseUrl,
  pickOpenAiImageSize,
  noStoreHeaders,
  resolveOpenAiEndpoint,
} from "@/lib/ai";
import { recordFailureLog } from "@/lib/diagnostics";
import { coerceImageValueToBase64 } from "@/lib/image-generation/shared-utils";
import { resolveBuiltInWithCatalog, rewriteUpstreamError } from "@/lib/built-in-api-service/catalog-resolver";
import {
  generateImageWithCompatibility,
  handleCompatibilityError,
  initializeCompatibilitySystem,
  convertLegacyParameters
} from "@/lib/api-compatibility/integration";
import { queuedFetch } from "@/lib/request-queue-manager";
// Enhanced image editing imports
import {
  EditRequest,
  EditResponse,
  EnhancedImageRequest,
  EnhancedImageResponse,
  ExistingImageRequest,
  LegacyImageResponse
} from "@/lib/image-editing/types";
import { APIIntegrationLayer, apiIntegrationLayer } from "@/lib/image-editing/api-integration-layer";
// Async image generation imports
import { createTask, isDatabaseAvailable, ensureTableExists } from "@/lib/async-image-generation/task-manager";
import { generateAsync } from "@/lib/async-image-generation/image-generator";

type InlineImage = {
  data: string;
  mimeType: string;
};

type Provider = "openai" | "gemini" | "gemini_compat";
type ImageResponseFormat = "auto" | "b64_json" | "base64" | "url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180; // Extended for long image generation

/**
 * 🔧 FIX: 在任何成功的图片生成后记录用量到数据库
 */
async function recordBuiltInUsageIfNeeded(
  useBuiltIn: boolean,
  userId: string | undefined,
  serviceId?: string,
  success: boolean = true,
  responseTime?: number,
  error?: string
): Promise<void> {
  if (!useBuiltIn || !userId) return;
  try {
    const { recordUsageToDatabase } = await import("@/lib/built-in-api-service/db");
    const requestId = `img_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const resolvedServiceId = serviceId || "built-in-default";
    await recordUsageToDatabase(requestId, userId, resolvedServiceId, success, responseTime, error);
    console.log("📊 Usage recorded for built-in service user:", userId, "success:", success);
  } catch (usageError) {
    console.error("Failed to record built-in usage:", usageError);
  }
}

const normalizeRemoteBase = (base?: string) =>
  (base || "").trim().replace(/\/+$/, "");

const getRemoteBuiltInBase = () => {
  const raw =
    process.env.BUILT_IN_SERVICE_SERVER_URL ||
    process.env.NEXT_PUBLIC_BUILT_IN_SERVICE_SERVER_URL ||
    "";
  const normalized = normalizeRemoteBase(raw);
  if (!normalized) return "";
  if (process.env.ELECTRON_DESKTOP !== "1") return "";
  return normalized;
};


// -------- Utilities --------
const toInlinePart = (img: InlineImage) => ({
  inlineData: { mimeType: img.mimeType, data: img.data },
});

const toGeminiImage = (img: InlineImage) => ({
  imageBytes: img.data,
  mimeType: img.mimeType,
});

const extractGeminiGeneratedImage = (response: any) =>
  response?.generatedImages?.[0]?.image?.imageBytes || "";

const extractGeminiInlineImage = (response: any) => {
  for (const part of response?.candidates?.[0]?.content?.parts || []) {
    if (part.inlineData?.data) {
      return part.inlineData.data as string;
    }
  }
  return "";
};

const shouldUseGeminiPreviewModel = (model: string) =>
  /preview/i.test(model);

const shouldUseGeminiAlpha = (model: string) =>
  /preview|exp|experimental|alpha/i.test(model);

const resolveBuiltInImageConfig = (userId: string) =>
  resolveBuiltInWithCatalog(userId, "image");

const describeGeminiStyle = async (
  ai: GoogleGenAI,
  model: string,
  images: InlineImage[]
) => {
  if (!images.length) return "";
  try {
    const response = await ai.models.generateContent({
      model,
      contents: {
        parts: [
          {
            text: "Summarize the visual style of the reference images. Describe palette, typography vibe, layout rhythm, and illustration style.",
          },
          ...images.map(toInlinePart),
        ],
      },
    });
    return response.text || "";
  } catch {
    return "";
  }
};

const buildGeminiReferenceImages = (
  inputImage: InlineImage | undefined,
  maskImage: InlineImage | undefined,
  referenceImages: InlineImage[]
) => {
  const references: Array<
    RawReferenceImage | MaskReferenceImage | StyleReferenceImage
  > = [];

  if (inputImage) {
    const raw = new RawReferenceImage();
    raw.referenceImage = toGeminiImage(inputImage);
    references.push(raw);
  }

  if (maskImage) {
    const mask = new MaskReferenceImage();
    mask.referenceImage = toGeminiImage(maskImage);
    mask.config = { maskMode: MaskReferenceMode.MASK_MODE_USER_PROVIDED };
    references.push(mask);
  }

  for (const img of referenceImages) {
    const style = new StyleReferenceImage();
    style.referenceImage = toGeminiImage(img);
    references.push(style);
  }

  return references;
};

const toInlineUrl = (img: InlineImage) =>
  `data:${img.mimeType};base64,${img.data}`;

const readError = async (res: Response) => {
  try {
    const data = await res.json();
    const msg =
      data?.error?.message ||
      data?.error ||
      data?.message ||
      data?.detail ||
      "";
    return typeof msg === "string" && msg ? msg : "";
  } catch {
    const txt = await res.text().catch(() => "");
    return txt || "";
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const normalizeImageResponseFormat = (value: any): ImageResponseFormat => {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "b64_json" || raw === "base64" || raw === "url") return raw;
  return "auto";
};

const parseSseJson = (rawText: string) => {
  if (!rawText.includes("data:")) return null;
  const lines = rawText.split(/\r?\n/);
  const chunks: any[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      chunks.push(JSON.parse(payload));
    } catch {
      // Ignore malformed SSE chunks.
    }
  }
  if (!chunks.length) return null;

  const textParts: string[] = [];
  const contentParts: any[] = [];
  for (const chunk of chunks) {
    const choice = chunk?.choices?.[0];
    const pieces = [choice?.message?.content, choice?.delta?.content];
    for (const piece of pieces) {
      if (piece === undefined || piece === null) continue;
      if (typeof piece === "string") {
        textParts.push(piece);
      } else {
        contentParts.push(piece);
      }
    }
  }

  if (textParts.length) {
    contentParts.unshift(textParts.join(""));
  }
  if (!contentParts.length) {
    return chunks[chunks.length - 1];
  }
  const mergedContent = contentParts.length === 1 ? contentParts[0] : contentParts;
  return {
    choices: [{ message: { content: mergedContent }, delta: { content: mergedContent } }],
  };
};

const extractErrorMessage = (data: any, rawText: string) => {
  if (typeof data?.error?.message === "string" && data.error.message) {
    return data.error.message;
  }
  if (typeof data?.error === "string" && data.error) return data.error;
  if (typeof data?.message === "string" && data.message) return data.message;
  if (typeof data?.detail === "string" && data.detail) return data.detail;
  return rawText || "";
};

const isContentPolicyError = (data: any, rawText: string) => {
  const message = extractErrorMessage(data, rawText).toLowerCase();
  const code = typeof data?.error?.code === "string" ? data.error.code.toLowerCase() : "";
  const combined = `${message} ${code}`;

  return (
    combined.includes("content_policy_violation") ||
    combined.includes("responsibleaipolicyviolation") ||
    combined.includes("invalid prompt") ||
    combined.includes("invalid_prompt") ||
    combined.includes("safety system") ||
    combined.includes("content policy") ||
    combined.includes("content filter")
  );
};

const generateSafePrompt = (originalPrompt: string) => {
  // 为内容策略错误生成更安全的提示词
  const safePrompts = [
    "A simple geometric shape on a white background",
    "A minimalist design with basic colors",
    "A clean and simple illustration",
    "A basic diagram or chart",
    "A simple abstract pattern"
  ];

  // 如果原始提示词很短，可能是测试用的，使用第一个安全提示词
  if (originalPrompt.length < 20) {
    return safePrompts[0];
  }

  // 尝试保留原始提示词的核心概念，但使用更安全的表达
  const safeConcepts = originalPrompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2)
    .slice(0, 3)
    .join(' ');

  return safeConcepts ? `A simple illustration of ${safeConcepts}` : safePrompts[0];
};

const shouldForceChatFromError = (
  status: number,
  data: any,
  rawText: string
) => {
  // 404错误通常表示端点不存在，应该降级到聊天接口
  if (status === 404) return true;

  const message = extractErrorMessage(data, rawText).toLowerCase();
  const code =
    typeof data?.error?.code === "string"
      ? data.error.code.toLowerCase()
      : "";
  const combined = `${message} ${code}`;

  // 检测路由到聊天接口的错误模式
  if (combined.includes("messages")) {
    return (
      combined.includes("missing_field") ||
      combined.includes("required") ||
      combined.includes("field is required") ||
      combined.includes("parameter validation failed")
    );
  }

  // 检测其他表示图片接口不可用的错误模式
  const imageEndpointErrors = [
    "not found",
    "endpoint not found",
    "route not found",
    "bad_response_status_code",
    "openai_error",
    "invalid endpoint",
    "unsupported endpoint"
  ];

  return imageEndpointErrors.some(error => combined.includes(error));
};

const collectImageUrlsFromText = (text: string, urls: Set<string>) => {
  // Pattern 1: Standard Markdown image syntax: ![alt](url)
  const markdownRegex = /!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/g;
  let match = markdownRegex.exec(text);
  while (match) {
    urls.add(match[1]);
    match = markdownRegex.exec(text);
  }

  // Pattern 2: URLs with common image extensions
  const urlRegex = /(https?:\/\/[^\s)]+?\.(?:png|jpe?g|webp|gif)(?:\?[^\s)]*)?)/gi;
  match = urlRegex.exec(text);
  while (match) {
    urls.add(match[1]);
    match = urlRegex.exec(text);
  }

  // Pattern 3: Nano Banana Pro / Zeabur style URLs without file extension
  // These APIs often return URLs like: https://seeyjys.zeabur.app/images/xxx
  const zeaburRegex = /(https?:\/\/[^\s)]*zeabur\.app\/images\/[^\s)]+)/gi;
  match = zeaburRegex.exec(text);
  while (match) {
    const url = match[1].replace(/[)\]]+$/, ''); // Remove trailing brackets
    urls.add(url);
    match = zeaburRegex.exec(text);
  }

  // Pattern 4: Generic image API URLs (cloudflare, imgix, etc)
  const imageApiRegex = /(https?:\/\/(?:images\.|img\.|cdn\.)[^\s)]+)/gi;
  match = imageApiRegex.exec(text);
  while (match) {
    const url = match[1].replace(/[)\]]+$/, ''); // Remove trailing brackets
    urls.add(url);
    match = imageApiRegex.exec(text);
  }
};

const collectImageUrlsFromContent = (content: any, urls: Set<string>) => {
  if (!content) return;
  if (typeof content === "string") {
    collectImageUrlsFromText(content, urls);
    return;
  }
  if (Array.isArray(content)) {
    content.forEach((part) => collectImageUrlsFromContent(part, urls));
    return;
  }
  if (typeof content === "object") {
    const imageUrl = content?.image_url?.url || content?.image?.url || content?.url;
    if (typeof imageUrl === "string") {
      urls.add(imageUrl);
    }
    const text = content?.text || content?.content;
    if (typeof text === "string") {
      collectImageUrlsFromText(text, urls);
    }
  }
};

// Extract base64 from OpenAI-compatible responses
const extractBase64 = async (data: any): Promise<string> => {
  // Enhanced ModelGate specific response format handling
  console.log("Extracting base64 from response:", {
    hasData: !!data?.data,
    dataLength: Array.isArray(data?.data) ? data.data.length : 0,
    firstDataItem: data?.data?.[0] ? Object.keys(data.data[0]) : [],
    hasImages: !!data?.images,
    imagesLength: Array.isArray(data?.images) ? data.images.length : 0,
    responseKeys: data ? Object.keys(data) : [],
    sampleResponse: JSON.stringify(data).substring(0, 500)
  });

  // Try different field combinations for ModelGate and other providers
  const tryFields = [
    // Standard OpenAI format
    data?.data?.[0]?.b64_json,
    data?.data?.[0]?.b64,
    data?.data?.[0]?.base64,
    data?.data?.[0]?.image_base64,
    data?.data?.[0]?.image,

    // ModelGate specific formats - enhanced based on actual API responses
    data?.data?.[0]?.b64_json,
    data?.data?.[0]?.image,
    data?.data?.[0]?.content,
    data?.data?.[0]?.output,
    data?.images?.[0]?.b64_json,
    data?.images?.[0]?.base64,
    data?.images?.[0]?.image,
    data?.result?.data?.[0]?.b64_json,
    data?.result?.images?.[0]?.b64_json,

    // Additional ModelGate formats based on their API docs
    data?.output?.[0]?.b64_json,
    data?.output?.[0]?.image,
    data?.output?.[0]?.content,
    data?.output?.[0]?.data,

    // Other possible formats
    data?.data?.base64,
    data?.base64,
    data?.output?.base64,
    data?.output,
    data?.image,
    data?.b64_json,
    data?.content,

    // ModelGate may return nested structures
    data?.result?.output,
    data?.result?.image,
    data?.result?.base64,
    data?.response?.data,
    data?.response?.image,

    // Direct response formats (some APIs return base64 directly)
    typeof data === 'string' && data.length > 100 ? data : null,
  ];

  for (const val of tryFields) {
    if (typeof val === "string" && val.trim()) {
      const trimmed = val.trim();
      // More lenient base64 validation for different formats
      if (trimmed.length > 100) {
        // Check if it looks like base64 (allow some special chars that might be in the response)
        if (/^[A-Za-z0-9+/=\s\n\r-_]+$/.test(trimmed)) {
          // Clean up the base64 string
          const cleanBase64 = trimmed.replace(/[\s\n\r-_]/g, '');
          if (cleanBase64.length > 100 && /^[A-Za-z0-9+/=]+$/.test(cleanBase64)) {
            // 🔧 更宽松的 Base64 截断检测逻辑 - 减少误判
            const hasProperEnding = cleanBase64.endsWith('=') ||
              cleanBase64.endsWith('==') ||
              cleanBase64.length % 4 === 0;

            // 对于中等长度的数据，使用更宽松的检测策略
            if (cleanBase64.length >= 200 && cleanBase64.length < 1000) {
              // 中等长度数据可能是小图片或压缩图片，不一定是截断
              // 只有在明显格式错误时才认为是截断
              if (cleanBase64.length < 300 && !hasProperEnding) {
                console.warn('Short base64 data with bad format, likely truncated, length:', cleanBase64.length);
                continue;
              } else {
                console.log("Found base64 data (medium length, accepting), length:", cleanBase64.length);
                return cleanBase64;
              }
            } else if (cleanBase64.length < 200) {
              // 非常短的数据，很可能是截断，但给一些容错
              if (cleanBase64.length < 100) {
                console.warn('Very short base64 data, likely truncated, length:', cleanBase64.length);
                continue;
              } else if (hasProperEnding) {
                console.log("Found short but properly formatted base64 data, length:", cleanBase64.length);
                return cleanBase64;
              } else {
                console.warn('Short base64 data with questionable format, length:', cleanBase64.length);
                continue;
              }
            } else {
              // 长数据，使用更宽松的逻辑
              const isLikelyTruncated = cleanBase64.length < 500 && !hasProperEnding;
              if (isLikelyTruncated) {
                console.warn('Base64 data appears to be truncated, length:', cleanBase64.length, 'format check failed');
                continue;
              }

              console.log("Found valid base64 data, length:", cleanBase64.length);
              return cleanBase64;
            }
          }
        }

        // Check if it's a data URL
        if (trimmed.startsWith('data:image/')) {
          const base64Part = trimmed.split(',')[1];
          if (base64Part && base64Part.length > 100) {
            // 🔧 更宽松的 Data URL 中的 Base64 截断检测
            const hasProperEnding = base64Part.endsWith('=') ||
              base64Part.endsWith('==') ||
              base64Part.length % 4 === 0;

            if (base64Part.length < 500) {
              // 短数据，只有在明显格式错误时才认为是截断
              if (base64Part.length < 200 && !hasProperEnding) {
                console.warn('Data URL base64 with improper ending, likely truncated, length:', base64Part.length);
                continue;
              }
            } else {
              // 长数据进行检查，但更宽松
              const isLikelyTruncated = base64Part.length < 800 && !hasProperEnding;
              if (isLikelyTruncated) {
                console.warn('Data URL base64 appears to be truncated, length:', base64Part.length);
                continue;
              }
            }

            console.log("Found data URL, extracting base64 part");
            return base64Part.trim();
          }
        }
      }
    }
  }

  // If url returned, try fetch -> base64
  const urls = new Set<string>();
  const directUrl = data?.data?.[0]?.url || data?.url || data?.images?.[0]?.url || data?.result?.url || "";
  if (typeof directUrl === "string" && directUrl) {
    urls.add(directUrl);
  }

  const message = data?.choices?.[0]?.message;
  const delta = data?.choices?.[0]?.delta;
  if (message?.content) {
    collectImageUrlsFromContent(message.content, urls);
  }
  if (delta?.content) {
    collectImageUrlsFromContent(delta.content, urls);
  }

  for (const url of urls) {
    if (typeof url !== "string" || !url.trim()) continue;
    if (url.startsWith("data:image/")) {
      const base64 = url.split(",")[1];
      if (base64) {
        console.log("Converted data URL to base64");
        return base64.trim();
      }
    }
    if (!url.startsWith("http")) continue;
    try {
      console.log("Fetching image from URL:", url);
      const res = await queuedFetch(
        url,
        { signal: AbortSignal.timeout(30000) },
        "low"
      );
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const base64 = buf.toString("base64");
      console.log("Converted URL to base64, length:", base64.length);
      return base64;
    } catch (error) {
      console.log("Failed to fetch URL:", url, error);
      continue;
    }
  }

  // Enhanced debug logging
  console.log("Failed to extract base64. Full response analysis:", {
    responseType: typeof data,
    isArray: Array.isArray(data),
    hasData: !!data?.data,
    dataType: typeof data?.data,
    dataIsArray: Array.isArray(data?.data),
    dataLength: Array.isArray(data?.data) ? data.data.length : 'N/A',
    firstDataKeys: data?.data?.[0] ? Object.keys(data.data[0]) : 'N/A',
    firstDataValues: data?.data?.[0] ? Object.entries(data.data[0]).map(([k, v]) => [k, typeof v, typeof v === 'string' ? v.substring(0, 50) : v]) : 'N/A',
    hasImages: !!data?.images,
    imagesType: typeof data?.images,
    responseKeys: data && typeof data === 'object' ? Object.keys(data) : 'N/A',
    fullResponse: JSON.stringify(data, null, 2).substring(0, 1000)
  });

  return "";
};

// 检测是否为多模态模型
const isMultimodalModel = (model: string): boolean => {
  const multimodalPatterns = [
    /gpt-4.*vision/i,
    /gpt-4o/i,
    /claude.*vision/i,
    /claude-3/i,
    /gemini.*pro.*vision/i,
    /gemini.*flash/i,
    /qwen.*vl/i,
    /yi.*vision/i,
    /internvl/i,
    /cogvlm/i,
    /llava/i,
    /minicpm.*v/i,
    /phi.*vision/i,
    /pixtral/i,
    /vision/i,
    /multimodal/i,
    /vl-/i,
    /-vl/i
  ];

  return multimodalPatterns.some(pattern => pattern.test(model));
};

// 从聊天响应中提取图片
const extractImagesFromChatResponse = async (data: any): Promise<string> => {
  console.log("Extracting images from chat response:", {
    hasChoices: !!data?.choices,
    choicesLength: Array.isArray(data?.choices) ? data.choices.length : 0,
    firstChoice: data?.choices?.[0] ? Object.keys(data.choices[0]) : [],
    sampleResponse: JSON.stringify(data).substring(0, 500)
  });

  // 🔧 新增：从聊天内容中直接提取 Base64 和 URL
  if (data?.choices && Array.isArray(data.choices)) {
    for (const choice of data.choices) {
      const message = choice?.message || choice?.delta;
      if (message?.content) {
        const content = typeof message.content === 'string' ? message.content : '';

        // 方法0: 🔧 优先处理 Nano Banana Pro / Zeabur 格式的URL（可能没有文件扩展名）
        // Pattern: https://seeyjys.zeabur.app/images/xxx 或 Markdown格式
        const zeaburMarkdownMatch = content.match(/!\[.*?\]\((https?:\/\/[^\s)]*zeabur\.app\/images\/[^\s)]+)\)/i);
        if (zeaburMarkdownMatch) {
          const url = zeaburMarkdownMatch[1].replace(/[)\]]+$/, ''); // Remove trailing brackets
          console.log('Found Nano Banana Pro / Zeabur Markdown image URL:', url);
          try {
            const res = await queuedFetch(url, {
              signal: AbortSignal.timeout(30000)
            }, 'low');
            if (res.ok) {
              const buf = Buffer.from(await res.arrayBuffer());
              const base64 = buf.toString("base64");
              console.log("Converted Zeabur URL to base64, length:", base64.length);
              return base64;
            }
          } catch (error) {
            console.log("Failed to fetch Zeabur URL:", url, error);
          }
        }

        // 检查直接 Zeabur URL（非 Markdown 格式）
        const zeaburDirectMatch = content.match(/(https?:\/\/[^\s)]*zeabur\.app\/images\/[^\s)]+)/i);
        if (zeaburDirectMatch && !zeaburMarkdownMatch) {
          const url = zeaburDirectMatch[1].replace(/[)\]]+$/, '');
          console.log('Found direct Zeabur image URL:', url);
          try {
            const res = await queuedFetch(url, {
              signal: AbortSignal.timeout(30000)
            }, 'low');
            if (res.ok) {
              const buf = Buffer.from(await res.arrayBuffer());
              const base64 = buf.toString("base64");
              console.log("Converted direct Zeabur URL to base64, length:", base64.length);
              return base64;
            }
          } catch (error) {
            console.log("Failed to fetch direct Zeabur URL:", url, error);
          }
        }

        // 方法1: 查找 HTTP/HTTPS 图片 URL（带文件扩展名）
        const httpUrlMatch = content.match(/(https?:\/\/[^\s)]+?\.(?:png|jpe?g|webp|gif)(?:\?[^\s)]*)?)/i);
        if (httpUrlMatch) {
          console.log('Found HTTP image URL in chat response');
          try {
            const res = await queuedFetch(httpUrlMatch[1], {
              signal: AbortSignal.timeout(30000)
            }, 'low');
            if (res.ok) {
              const buf = Buffer.from(await res.arrayBuffer());
              const base64 = buf.toString("base64");
              console.log("Converted HTTP URL to base64, length:", base64.length);
              return base64;
            }
          } catch (error) {
            console.log("Failed to fetch HTTP URL:", httpUrlMatch[1], error);
          }
        }

        // 方法2: 查找 Markdown 格式的 HTTP 图片（带文件扩展名）
        const markdownHttpMatch = content.match(/!\[.*?\]\((https?:\/\/[^\s)]+?\.(?:png|jpe?g|webp|gif)(?:\?[^\s)]*)?)\)/i);
        if (markdownHttpMatch) {
          console.log('Found Markdown HTTP image in chat response');
          try {
            const res = await queuedFetch(markdownHttpMatch[1], {
              signal: AbortSignal.timeout(30000)
            }, 'low');
            if (res.ok) {
              const buf = Buffer.from(await res.arrayBuffer());
              const base64 = buf.toString("base64");
              console.log("Converted Markdown HTTP URL to base64, length:", base64.length);
              return base64;
            }
          } catch (error) {
            console.log("Failed to fetch Markdown HTTP URL:", markdownHttpMatch[1], error);
          }
        }

        // 方法3: 查找 data:image/ 格式的图片（检查截断）
        const dataUrlMatch = content.match(/data:image\/[^,]+,([A-Za-z0-9+/=]+)/);
        if (dataUrlMatch) {
          const base64Data = dataUrlMatch[1];
          // 🔧 改进的 Base64 截断检测
          const hasProperEnding = base64Data.endsWith('=') ||
            base64Data.endsWith('==') ||
            base64Data.length % 4 === 0;

          if (base64Data.length < 500) {
            // 短数据只检查格式
            if (!hasProperEnding) {
              console.warn('Data URL base64 with improper ending, likely truncated, length:', base64Data.length);
            } else {
              console.log('Found complete short data URL in chat response');
              return base64Data;
            }
          } else {
            // 长数据进行更严格检查
            const isLikelyTruncated = base64Data.length < 1000 && !hasProperEnding;
            if (isLikelyTruncated) {
              console.warn('Data URL base64 appears to be truncated, length:', base64Data.length);
            } else {
              console.log('Found complete data URL in chat response');
              return base64Data;
            }
          }
        }

        // 方法4: 查找 Markdown 图片格式（检查截断）
        const markdownMatch = content.match(/!\[.*?\]\(data:image\/[^,]+,([A-Za-z0-9+/=]+)\)/);
        if (markdownMatch) {
          const base64Data = markdownMatch[1];
          const hasProperEnding = base64Data.endsWith('=') ||
            base64Data.endsWith('==') ||
            base64Data.length % 4 === 0;

          if (base64Data.length < 500) {
            if (!hasProperEnding) {
              console.warn('Markdown base64 data with improper ending, likely truncated, length:', base64Data.length);
            } else {
              console.log('Found complete short Markdown image in chat response');
              return base64Data;
            }
          } else {
            const isLikelyTruncated = base64Data.length < 1000 && !hasProperEnding;
            if (isLikelyTruncated) {
              console.warn('Markdown base64 data appears to be truncated, length:', base64Data.length);
            } else {
              console.log('Found complete Markdown image in chat response');
              return base64Data;
            }
          }
        }

        // 方法5: 查找纯 base64 数据（最后尝试，对稳定 API 更宽松）
        if (content.length > 500 && /^[A-Za-z0-9+/=\s]+$/.test(content.trim())) {
          const cleanBase64 = content.replace(/\s/g, '');
          if (cleanBase64.length > 500) {
            // 🔧 对已知稳定 API 的宽松检测

            if (isFromStableApi && cleanBase64.length > 200) {
              // 对稳定 API 的聊天响应更宽松
              console.log('Found pure base64 content in chat response from stable source');
              return cleanBase64;
            } else {
              // 原有的严格检测逻辑
              const hasProperEnding = cleanBase64.endsWith('=') ||
                cleanBase64.endsWith('==') ||
                cleanBase64.length % 4 === 0;

              if (cleanBase64.length < 1000) {
                if (!hasProperEnding) {
                  console.warn('Pure base64 content with improper ending, likely truncated, length:', cleanBase64.length);
                } else {
                  console.log('Found pure base64 content in chat response');
                  return cleanBase64;
                }
              } else {
                console.log('Found long pure base64 content in chat response');
                return cleanBase64;
              }
            }
          }
        }
      }
    }
  }

  // 收集所有可能的图片URL（原有逻辑保留作为后备）
  const urls = new Set<string>();

  // 从choices中提取
  if (data?.choices && Array.isArray(data.choices)) {
    for (const choice of data.choices) {
      const message = choice?.message || choice?.delta;
      if (message?.content) {
        collectImageUrlsFromContent(message.content, urls);
      }
    }
  }

  // 直接从响应中提取
  collectImageUrlsFromContent(data, urls);

  // 尝试转换URL为base64
  for (const url of urls) {
    if (typeof url !== "string" || !url.trim()) continue;

    if (url.startsWith("data:image/")) {
      const base64 = url.split(",")[1];
      if (base64) {
        // 🔧 改进的 Data URL 截断检测
        const hasProperEnding = base64.endsWith('=') ||
          base64.endsWith('==') ||
          base64.length % 4 === 0;

        if (base64.length < 500) {
          if (!hasProperEnding) {
            console.warn('Data URL base64 with improper ending, likely truncated, length:', base64.length);
            continue;
          }
        } else {
          const isLikelyTruncated = base64.length < 1000 && !hasProperEnding;
          if (isLikelyTruncated) {
            console.warn('Data URL base64 appears to be truncated, length:', base64.length);
            continue;
          }
        }

        console.log("Found data URL in chat response");
        return base64.trim();
      }
    }

    if (url.startsWith("http")) {
      try {
        console.log("Fetching image from chat response URL:", url);
        const res = await queuedFetch(
          url,
          { signal: AbortSignal.timeout(30000) },
          "low"
        );
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        const base64 = buf.toString("base64");
        console.log("Converted chat response URL to base64, length:", base64.length);
        return base64;
      } catch (error) {
        console.log("Failed to fetch chat response URL:", url, error);
        continue;
      }
    }
  }

  return "";
};

// -------- OpenAI-compatible core flow --------
export async function POST(req: Request) {
  let controller: AbortController | null = null;
  let totalTimeout: NodeJS.Timeout | null = null;
  const requestStartTime = Date.now();
  const getElapsedMs = () => Math.max(1, Date.now() - requestStartTime);

  try {
    // Initialize compatibility system
    initializeCompatibilitySystem();

    const body = await req.json();

    const remoteBuiltInBase = getRemoteBuiltInBase();
    if (body?.useBuiltInService && remoteBuiltInBase) {
      const targetUrl = `${remoteBuiltInBase}/api/ai/image`;
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store'
      });

      const textBody = await response.text();
      try {
        const data = textBody ? JSON.parse(textBody) : {};
        return NextResponse.json(data, {
          status: response.status,
          headers: noStoreHeaders(),
        });
      } catch {
        return new NextResponse(textBody, {
          status: response.status,
          headers: noStoreHeaders(),
        });
      }
    }

    // ========== ASYNC MODE DETECTION ==========
    // Check if async image generation is enabled via environment variable
    // and explicitly requested by the client payload.
    const envValue = process.env.ENABLE_ASYNC_IMAGE_GENERATION;
    const requestAsync = body.useAsyncImageGeneration === true;
    const isAsyncEnabled = (envValue === 'true' || envValue === '1') && requestAsync;

    console.log('[AsyncImageGen] Environment check:', {
      envValue,
      type: typeof envValue,
      requestAsync,
      isAsyncEnabled
    });

    if (isAsyncEnabled) {

      // First check if database is available
      const dbAvailable = await isDatabaseAvailable();

      if (!dbAvailable) {
        // Continue to sync mode (don't return, let execution fall through)
      } else {
        // Database is available, ensure table exists on first request
        const tableReady = await ensureTableExists();

        if (!tableReady) {
          // Continue to sync mode
        } else {
          // Extract user ID from request (assuming Clerk authentication)
          const userId = body.userId || 'anonymous';
          const prompt = (body.prompt || "").trim();

          // Validate required parameters
          if (!prompt) {
            return NextResponse.json(
              { error: "Missing prompt." },
              { status: 400, headers: noStoreHeaders() }
            );
          }

          try {
            // Create task record
            console.log('[AsyncImageGen] Creating async task for user:', userId);
            console.log('[AsyncImageGen] Database status:', {
              hasPostgresUrl: !!process.env.POSTGRES_URL,
              dbAvailable: true,
              tableReady: true,
            });

            const taskRecord = await createTask({
              userId,
              prompt,
              requestParams: body, // Store all request parameters
            });

            console.log('[AsyncImageGen] Task created:', taskRecord.taskId);

            // Trigger background generation (don't await)
            // 🔧 FIX: Check if using built-in service and get API key accordingly
            const requestProvider = body.provider || "openai";
            let effectiveProvider = requestProvider;
            let effectiveApiKey = body.apiKey;
            let effectiveBaseUrl =
              requestProvider === "openai"
                ? body.openAiBaseUrl
                : requestProvider === "gemini_compat"
                  ? body.geminiCompatBaseUrl
                  : "";
            let effectiveModel =
              requestProvider === "openai" ? body.openAiImageModel : body.geminiImageModel;
            const useBuiltInService = body.useBuiltInService === true;

            console.log('[AsyncImageGen] API Key resolution:', {
              hasBodyApiKey: !!body.apiKey,
              bodyApiKeyLength: body.apiKey?.length || 0,
              hasBodyBaseUrl: !!body.openAiBaseUrl,
              useBuiltInServiceFlag: useBuiltInService,
              provider: body.provider,
            });

            // 🔧 IMPROVED: Always use built-in service when body.apiKey is empty or undefined
            if (useBuiltInService || !effectiveApiKey || effectiveApiKey.trim() === '') {
              // Check for built-in service credentials
              const builtInApiKey = process.env.GEMINI_BUILT_IN_API_KEY;
              const builtInBaseUrl = process.env.GEMINI_BUILT_IN_BASE_URL;
              const builtInModel = process.env.BUILT_IN_SERVICE_MODEL;

              console.log('[AsyncImageGen] Built-in service check:', {
                hasBuiltInApiKey: !!builtInApiKey,
                hasBuiltInBaseUrl: !!builtInBaseUrl,
                builtInModel,
              });

              if (builtInApiKey && builtInBaseUrl) {
                effectiveProvider = "openai";
                effectiveApiKey = builtInApiKey;
                effectiveBaseUrl = builtInBaseUrl;
                effectiveModel = body.openAiImageModel || body.geminiImageModel || builtInModel || 'gemini-2.0-flash-exp';
              } else if (!effectiveApiKey || effectiveApiKey.trim() === '') {
              }
            }

            // Extract generation parameters from body
            const generationParams = {
              prompt,
              provider: effectiveProvider,
              apiKey: effectiveApiKey,
              baseUrl: effectiveBaseUrl,
              openAiImageModel: effectiveModel,
              openAiAuthHeader: body.openAiAuthHeader,
              openAiImageEndpointPath: body.openAiImageEndpointPath,
              openAiImageResponseFormat: body.openAiImageResponseFormat,
              geminiApiKey: effectiveApiKey,
              geminiBaseUrl: effectiveProvider === "gemini_compat" ? effectiveBaseUrl : undefined,
              geminiImageModel: body.geminiImageModel || effectiveModel,
              aspectRatio: body.aspectRatio,
              imageSize: body.imageSize,
              inputImage: body.inputImage,
              maskImage: body.maskImage,
              referenceImages: body.referenceImages,
              providerId: body.providerId,
              providerName: body.providerName,
            };

            // Start background generation (fire and forget)
            generateAsync(taskRecord.taskId, generationParams).catch((error) => {
              console.error('[AsyncImageGen] Background generation error:', error);
              // Error is already handled in generateAsync, just log here
            });

            console.log('[AsyncImageGen] Background generation triggered');

            // Return task ID immediately
            return NextResponse.json(
              {
                taskId: taskRecord.taskId,
                status: 'pending',
                message: 'Image generation task created. Use the taskId to check status.',
              },
              { headers: noStoreHeaders() }
            );
          } catch (asyncError) {
            console.error('[AsyncImageGen] Failed to create async task:', {
              error: asyncError instanceof Error ? asyncError.message : 'Unknown error',
              stack: asyncError instanceof Error ? asyncError.stack : undefined,
              errorType: asyncError?.constructor?.name,
              userId,
              hasPrompt: !!prompt,
            });
            // Fall through to sync mode if async fails
            console.log('[AsyncImageGen] Falling back to sync mode due to error');
          }
        }
      }
    }
    // ========== END ASYNC MODE DETECTION ==========

    // DEBUG: Log request details for troubleshooting
    console.log("Image request debug summary", {
      hasInputImage: !!body.inputImage,
      hasMaskImage: !!body.maskImage,
      hasOriginalImage: !!body.originalImage,
      hasMasks: !!body.masks?.length,
      hasEditInstructions: !!body.editInstructions?.length,
      editingMode: body.editingMode,
      provider: body.provider,
      requestKeys: Object.keys(body),
    });

    // Check if this is an enhanced editing request
    const isEditingRequest = !!(
      body.editingMode === 'edit' ||
      body.originalImage ||
      body.masks?.length ||
      body.editInstructions?.length ||
      // Legacy editing detection: inputImage + maskImage indicates editing
      (body.inputImage && body.maskImage)
    );

    console.log("Editing request detection", {
      isEditingRequest,
      reason: isEditingRequest
        ? (body.editingMode === "edit"
          ? "editingMode=edit"
          : body.originalImage
            ? "has originalImage"
            : body.masks?.length
              ? "has masks"
              : body.editInstructions?.length
                ? "has editInstructions"
                : body.inputImage && body.maskImage
                  ? "legacy inputImage+maskImage"
                  : "unknown")
        : "not editing",
    });

    if (isEditingRequest) {

      try {
        // Extract editing parameters
        const inputImage = body.inputImage;
        const maskImage = body.maskImage;
        const editInstruction = body.prompt || 'Edit this image according to the mask';

        console.log("Editing request payload", {
          hasInputImage: !!inputImage,
          hasMaskImage: !!maskImage,
          instruction: editInstruction,
        });

        if (!inputImage || !maskImage) {
          return NextResponse.json(
            { error: "Missing inputImage or maskImage for editing request." },
            { status: 400, headers: noStoreHeaders() }
          );
        }

        // 🎯 BALANCED EDITING PROMPT: Precise editing while preserving all unmasked content
        const enhancedPrompt = `EDIT INSTRUCTION: ${editInstruction}

EDITING RULES:
- Apply the requested changes ONLY to the masked (white/bright) areas
- KEEP ALL content outside the mask completely unchanged and visible
- Preserve the original layout, colors, fonts, and styling
- Maintain all existing text, graphics, and elements that are not in the masked area
- Do not remove, hide, or alter any unmasked content
- Focus on making the specific change requested while keeping everything else identical

Important: The mask indicates where to make changes. All other areas should remain exactly as they were in the original image.`;

        // Apply enhanced prompt
        body.prompt = enhancedPrompt;

        // Add high-fidelity parameters for better editing quality
        if (body.provider === 'openai') {
          body.input_fidelity = 'high';
        }

        // Force editing endpoint usage for OpenAI
        if (body.provider === 'openai' && inputImage && maskImage) {
          // The existing code will handle this in the tryEdit() function
        }


      } catch (error) {
        return NextResponse.json(
          { error: "Failed to process editing request: " + (error instanceof Error ? error.message : 'Unknown error') },
          { status: 500, headers: noStoreHeaders() }
        );
      }
    } else {
    }

    // 🔧 BUILT-IN API SERVICE INTEGRATION
    // Check if user wants to use built-in API service
    const useBuiltInService = body.useBuiltInService === true;
    const userId = body.userId; // This should come from authentication context

    if (useBuiltInService && userId) {

      try {
        // Import built-in API service
        const { getBuiltInAPIService } = await import('@/lib/built-in-api-service');
        const builtInService = getBuiltInAPIService();

        // Check if user is authorized
        const isAuthorized = await builtInService.checkUserAuthorization(userId);
        if (!isAuthorized) {
        } else {
          // Get user's current service status
          let serviceStatus = await builtInService.getCurrentServiceStatus(userId);

          if (!serviceStatus.isUsingBuiltIn) {
            const availableServices = await builtInService.getAvailableServices(userId);
            const builtInOption = availableServices.find(
              (service) => service.isBuiltIn && service.isAvailable
            );

            if (builtInOption) {
              const switchResult = await builtInService.switchToBuiltInService(
                userId,
                builtInOption.id
              );
              if (switchResult.success) {
                serviceStatus = await builtInService.getCurrentServiceStatus(userId);
              }
            }
          }

          if (serviceStatus.isUsingBuiltIn) {

            const builtInModel = (
              body.openAiImageModel ||
              body.geminiImageModel ||
              body.model ||
              ""
            ).trim();
            const responseFormat =
              body.openAiImageResponseFormat ||
              body.response_format ||
              "b64_json";

            // Create proxy request
            const proxyRequest = {
              userId,
              serviceId: serviceStatus.currentService.id,
              prompt: (body.prompt || "").trim(),
              model: builtInModel || undefined,
              size: body.imageSize || body.aspectRatio,
              quality: body.quality,
              response_format: responseFormat,
              n: 1
            };

            // Proxy through built-in service
            const builtInResponse = await builtInService.proxyImageGeneration(proxyRequest);

            if (builtInResponse && builtInResponse.imageBase64) {

              // 🔧 NEW: 记录用量到数据库
              try {
                const { recordUsageToDatabase } = await import('@/lib/built-in-api-service/db');
                await recordUsageToDatabase(
                  `img_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
                  userId,
                  serviceStatus.currentService.id,
                  true,
                  getElapsedMs(),
                );
              } catch (usageError) {
                // 不影响主流程
              }

              return NextResponse.json(
                {
                  imageBase64: builtInResponse.imageBase64,
                  revised_prompt: builtInResponse.revised_prompt,
                  metadata: {
                    ...builtInResponse.metadata,
                    source: 'built-in-service'
                  }
                },
                { headers: noStoreHeaders() }
              );
            } else {
            }
          } else {
          }
        }
      } catch (error) {
        // Continue with existing logic as fallback
      }
    }

    // Continue with existing generation logic for backward compatibility
    let provider =
      body.provider === "openai"
        ? "openai"
        : body.provider === "gemini_compat"
          ? "gemini_compat"
          : "gemini";
    let apiKey = (body.apiKey || "").trim();
    const prompt = (body.prompt || "").trim();
    const forceChatImage = !!body.openAiForceChatImage;
    const aspectRatio = (body.aspectRatio || "").trim() || "1:1";
    const imageSize = (body.imageSize || "").trim();
    const styleHintOverride = (body.styleHint || "").trim();
    const referenceImages = Array.isArray(body.referenceImages)
      ? (body.referenceImages as InlineImage[])
      : [];
    const inputImage = body.inputImage as InlineImage | undefined;
    const maskImage = body.maskImage as InlineImage | undefined;

    let builtInFallbackConfig: Awaited<ReturnType<typeof resolveBuiltInImageConfig>> = null;
    if (!apiKey && useBuiltInService && userId) {
      builtInFallbackConfig = await resolveBuiltInImageConfig(userId);
      if (builtInFallbackConfig) {
        apiKey = builtInFallbackConfig.apiKey;
        provider = "openai";
      }
    }

    if (!apiKey || !prompt) {
      return NextResponse.json(
        { error: "Missing apiKey or prompt." },
        { status: 400, headers: noStoreHeaders() }
      );
    }

    if (provider === "gemini" || provider === "gemini_compat") {
      const geminiTextModel =
        (body.geminiTextModel || "").trim() || defaultGeminiTextModel;
      const geminiImageModel =
        (body.geminiImageModel || "").trim() || defaultGeminiImageModel;
      const usePreviewModel = shouldUseGeminiPreviewModel(geminiImageModel);
      const geminiCompat =
        provider === "gemini_compat"
          ? normalizeGeminiBaseUrl(body.geminiCompatBaseUrl)
          : null;
      const apiVersion =
        shouldUseGeminiAlpha(geminiTextModel) ||
          shouldUseGeminiAlpha(geminiImageModel)
          ? "v1alpha"
          : geminiCompat?.apiVersion;
      const ai = new GoogleGenAI({
        apiKey,
        ...(apiVersion ? { apiVersion } : {}),
        ...(geminiCompat
          ? { httpOptions: { baseUrl: geminiCompat.baseUrl, apiVersion } }
          : {}),
      });
      const styleHint =
        styleHintOverride ||
        (await describeGeminiStyle(ai, geminiTextModel, referenceImages));
      const finalPrompt = styleHint
        ? `${prompt}\n\nStyle reference summary: ${styleHint}`
        : prompt;

      const normalizedImageSize =
        imageSize === "1K" || imageSize === "2K" ? imageSize : "";
      const config = {
        numberOfImages: 1,
        ...(aspectRatio ? { aspectRatio } : {}),
        ...(normalizedImageSize ? { imageSize: normalizedImageSize } : {}),
      };

      const wantsEdit = !!inputImage || !!maskImage;
      if (wantsEdit) {
        try {
          const references = buildGeminiReferenceImages(
            inputImage,
            maskImage,
            referenceImages
          );
          const response = await ai.models.editImage({
            model: geminiImageModel,
            prompt: finalPrompt,
            referenceImages: references,
            config,
          });
          const imageBase64 = extractGeminiGeneratedImage(response);
          if (!imageBase64) {
            return NextResponse.json(
              { error: "No image generated." },
              { status: 502, headers: noStoreHeaders() }
            );
          }
          // 🔧 FIX: 记录用量（Gemini edit路径）
          await recordBuiltInUsageIfNeeded(
            useBuiltInService,
            userId,
            undefined,
            true,
            getElapsedMs()
          );
          return NextResponse.json(
            { imageBase64 },
            { headers: noStoreHeaders() }
          );
        } catch (error) {
          if (!usePreviewModel) throw error;
        }
      }

      if (usePreviewModel) {
        const parts: any[] = [];
        if (inputImage) parts.push(toInlinePart(inputImage));
        if (maskImage) parts.push(toInlinePart(maskImage));
        for (const img of referenceImages) {
          parts.push(toInlinePart(img));
        }
        parts.push({ text: finalPrompt });

        const response = await ai.models.generateContent({
          model: geminiImageModel,
          contents: { parts },
          config: {
            imageConfig: {
              aspectRatio,
              ...(imageSize ? { imageSize } : {}),
            },
          },
        });

        const imageBase64 = extractGeminiInlineImage(response);
        if (!imageBase64) {
          return NextResponse.json(
            { error: "No image generated." },
            { status: 502, headers: noStoreHeaders() }
          );
        }

        // 🔧 FIX: 记录用量（Gemini preview路径）
        await recordBuiltInUsageIfNeeded(
          useBuiltInService,
          userId,
          undefined,
          true,
          getElapsedMs()
        );
        return NextResponse.json(
          { imageBase64 },
          { headers: noStoreHeaders() }
        );
      }

      const response = await ai.models.generateImages({
        model: geminiImageModel,
        prompt: finalPrompt,
        config,
      });

      const imageBase64 = extractGeminiGeneratedImage(response);
      if (!imageBase64) {
        return NextResponse.json(
          { error: "No image generated." },
          { status: 502, headers: noStoreHeaders() }
        );
      }

      // 🔧 FIX: 记录用量（Gemini standard路径）
      await recordBuiltInUsageIfNeeded(
        useBuiltInService,
        userId,
        undefined,
        true,
        getElapsedMs()
      );
      return NextResponse.json(
        { imageBase64 },
        { headers: noStoreHeaders() }
      );
    }

    // Enhanced OpenAI-compatible processing with compatibility system
    if (provider === "openai") {
      const openAiBaseUrl =
        builtInFallbackConfig?.baseUrl || body.openAiBaseUrl || "https://api.openai.com/v1";
      const openAiImageModel =
        (body.openAiImageModel || builtInFallbackConfig?.model || "").trim() ||
        defaultOpenAiImageModel;
      try {
        // Use the enhanced compatibility system for OpenAI providers
        const response = await generateImageWithCompatibility(
          prompt,
          apiKey,
          openAiBaseUrl,
          {
            model: openAiImageModel,
            size: pickOpenAiImageSize(aspectRatio),
            response_format: body.openAiImageResponseFormat || defaultOpenAiImageResponseFormat,
            n: 1,
            authType: (() => {
              const authHeader = normalizeOpenAiAuthHeader(body.openAiAuthHeader);
              if (authHeader === "authorization") return "bearer";
              if (authHeader === "x-api-key") return "api_key";
              return "custom_header";
            })(),
            providerId: body.providerId,
            providerName: body.providerName
          }
        );

        // Convert response to expected format
        if (response.images && response.images.length > 0) {
          const image = response.images[0];
          // 🔧 FIX (2026-05 #5 反复修复的"破坏缩略图 / 当前页生成失败"根因):
          // 同 api-proxy-layer.ts:527 — gpt-image-2 等服务即使要 b64_json
          // 也常返回 { url: "https://..." } 远程短时签名链接。旧实现把这个 URL
          // 当 imageBase64 透传给前端，前端 <img> 加载远程链接因签名过期 / CORS /
          // 防盗链失败 → "破坏缩略图"。统一在服务端 fetch 转 base64。
          const rawValue = image.b64_json || image.url || "";
          const imageBase64 = await coerceImageValueToBase64(rawValue);

          if (imageBase64) {
            // 🔧 FIX: 记录用量（OpenAI compatibility system路径）
            await recordBuiltInUsageIfNeeded(
              useBuiltInService,
              userId,
              undefined,
              true,
              getElapsedMs()
            );
            return NextResponse.json(
              { imageBase64 },
              { headers: noStoreHeaders() }
            );
          }
        }

        // If no image data, fall through to original logic
      } catch (compatibilityError) {
        console.log('Compatibility system failed, falling back to original logic:', compatibilityError);

        // Handle compatibility errors gracefully
        const errorInfo = handleCompatibilityError(compatibilityError);

        // If it's a non-retryable error, return it immediately
        if (!errorInfo.canRetry) {
          return NextResponse.json(
            {
              error: errorInfo.userMessage,
              details: errorInfo.technicalDetails,
              suggestions: errorInfo.suggestions
            },
            { status: 400, headers: noStoreHeaders() }
          );
        }

        // For retryable errors, fall through to original logic
      }
    }

    // Original OpenAI-compatible logic (fallback)
    // Normalize base URL strictly to OpenAI format
    const baseUrl = normalizeOpenAiBaseUrl(
      builtInFallbackConfig?.baseUrl || body.openAiBaseUrl
    );
    const openAiAuthHeader = normalizeOpenAiAuthHeader(body.openAiAuthHeader);
    const openAiImageEndpointPath =
      (body.openAiImageEndpointPath || defaultOpenAiImageEndpointPath).trim() ||
      defaultOpenAiImageEndpointPath;
    const openAiImageResponseFormat = normalizeImageResponseFormat(
      body.openAiImageResponseFormat || defaultOpenAiImageResponseFormat
    );
    const imageModel =
      (body.openAiImageModel || builtInFallbackConfig?.model || "").trim() ||
      defaultOpenAiImageModel;
    const textModel =
      (body.openAiTextModel || builtInFallbackConfig?.model || "").trim() ||
      defaultOpenAiTextModel;
    const visionModel =
      (body.openAiVisionModel || builtInFallbackConfig?.model || "").trim() ||
      textModel ||
      defaultOpenAiVisionModel;
    const chatModel = visionModel || textModel || imageModel;

    // Build payload variants in strict OpenAI-compatible style
    const size = pickOpenAiImageSize(aspectRatio);
    const addSize = (payload: any) =>
      imageSize && /^\d+x\d+$/i.test(imageSize)
        ? { ...payload, size: imageSize }
        : { ...payload, size };

    const baseMessages = [
      {
        role: "system",
        content:
          "You are an image generator. Return a base64 PNG, a data URL, or a direct image URL (Markdown image is ok).",
      },
      { role: "user", content: prompt },
    ];

    const buildImagePayloads = () => {
      const base: any = { model: imageModel, prompt };

      // Check if this is ModelGate API
      const isModelGate = baseUrl.includes('mg.aid.pub');

      if (isModelGate) {
        // ModelGate specific parameters
        base.number_results = 1; // ModelGate uses number_results instead of n
        base.output_format = 'png';
        base.output_type = 'base64'; // Recommended for China users

        // Ensure we're using a supported model
        if (!base.model || (!base.model.includes('volcengine/doubao-seedream') && !base.model.includes('google/nano-banana'))) {
          base.model = 'volcengine/doubao-seedream-4-0'; // Default ModelGate image model
        }

        // ModelGate specific size handling
        if (imageSize && /^\d+x\d+$/i.test(imageSize)) {
          base.size = imageSize;
        } else {
          base.size = size; // Use the calculated size
        }

        if (openAiImageResponseFormat !== "auto") {
          return [{ ...base, response_format: openAiImageResponseFormat }];
        }

        // For ModelGate, try base64 output first, then other formats
        return [
          { ...base, output_type: 'base64' },
          { ...base, response_format: "b64_json" },
          { ...base, response_format: "base64" },
          { ...base }, // Fallback without specific format
        ];
      } else {
        // Standard OpenAI format
        base.n = 1;

        const addSize = (payload: any) =>
          imageSize && /^\d+x\d+$/i.test(imageSize)
            ? { ...payload, size: imageSize }
            : { ...payload, size };

        if (openAiImageResponseFormat !== "auto") {
          return [addSize({ ...base, response_format: openAiImageResponseFormat })];
        }
        return [
          addSize({ ...base, response_format: "b64_json" }),
          addSize({ ...base, response_format: "base64" }),
          addSize({ ...base, response_format: "url" }),
          addSize(base),
        ];
      }
    };

    const buildChatPayloads = () => {
      // 为多模态模型优化的图片生成提示词
      const imageGenerationPrompt = `You are an advanced AI image generator. Generate a high-quality image based on the following description.

IMPORTANT INSTRUCTIONS:
1. Generate the image and return it as a base64-encoded PNG
2. You can return the image in any of these formats:
   - As a data URL: data:image/png;base64,[base64_data]
   - As a markdown image: ![Generated Image](data:image/png;base64,[base64_data])
   - As plain base64 data (will be automatically detected)
   - As an image URL if you generate and host the image

Image Description: ${prompt}

Please generate the image now and return it in one of the supported formats above.`;

      const baseMessages = [
        {
          role: "system",
          content: "You are an advanced AI assistant capable of generating images. When asked to generate an image, you should create it and return it in a format that can be displayed (base64, data URL, or image URL)."
        },
        {
          role: "user",
          content: imageGenerationPrompt
        },
      ];

      return [
        { model: chatModel, messages: baseMessages },
        {
          model: chatModel,
          messages: baseMessages,
          response_format: { type: "json_object" },
          // 为某些模型添加额外参数
          max_tokens: 4000,
          temperature: 0.7
        },
      ];
    };

    // Input image / mask: try edits endpoint first
    const buildEditForm = () => {
      const form = new FormData();
      form.append("model", imageModel);
      form.append("prompt", prompt);
      form.append("response_format", "b64_json");
      form.append("size", size);

      // Add high-fidelity parameter if available
      if (body.input_fidelity) {
        form.append("input_fidelity", body.input_fidelity);
      }

      if (inputImage) {
        form.append(
          "image",
          new Blob([Buffer.from(inputImage.data, "base64")], {
            type: inputImage.mimeType,
          }) as any,
          "image.png"
        );
      }
      if (maskImage) {
        form.append(
          "mask",
          new Blob([Buffer.from(maskImage.data, "base64")], {
            type: maskImage.mimeType,
          }) as any,
          "mask.png"
        );
      }
      return form;
    };

    controller = new AbortController();
    totalTimeout = setTimeout(() => {
      if (controller && !controller.signal.aborted) {
        console.log('Request timeout after 180 seconds, aborting...');
        controller.abort();
      }
    }, 180000);
    const imageEndpoint = resolveOpenAiEndpoint(
      baseUrl,
      openAiImageEndpointPath
    );
    const shouldSkipImageEndpoint = imageEndpoint.includes("/chat/completions");

    const logFailure = (entry: {
      operation: string;
      url: string;
      status: number | null;
      requestBody?: unknown;
      responseBody?: unknown;
    }) => {
      recordFailureLog({
        provider: "openai",
        ...entry,
      });
    };

    const fetchJson = async (
      url: string,
      payload: any,
      operation: string,
      priority: 'high' | 'normal' | 'low' = 'normal'
    ) => {
      try {
        const res = await queuedFetch(url, {
          method: "POST",
          headers: buildOpenAiHeaders(apiKey, true, openAiAuthHeader),
          body: JSON.stringify(payload),
          signal: controller?.signal,
        }, priority);
        const rawText = await res.text().catch(() => "");
        let data: any = {};
        if (rawText) {
          try {
            data = JSON.parse(rawText);
          } catch {
            data = parseSseJson(rawText) || {};
          }
        }
        return { res, data, rawText };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || "");

        // 更精确的中断错误检测
        if (error instanceof Error && error.name === 'AbortError') {
          console.log(`Request properly aborted for ${url}: ${message}`);
          logFailure({
            operation,
            url,
            status: null,
            requestBody: payload,
            responseBody: `Request aborted: ${message}`,
          });
          throw new Error(`Request timeout after 180 seconds: ${message}`);
        }

        // 检测其他中断相关错误
        if (message.includes("aborted") || message.includes("AbortError")) {
          console.log(`Request aborted for ${url}: ${message}`);
          logFailure({
            operation,
            url,
            status: null,
            requestBody: payload,
            responseBody: `Request aborted: ${message}`,
          });
          throw new Error(`Request timeout: ${message}`);
        }

        // 检测网络连接问题
        const isNetworkError = message.includes("fetch failed") ||
          message.includes("ENOTFOUND") ||
          message.includes("ECONNREFUSED") ||
          message.includes("ETIMEDOUT") ||
          message.includes("certificate") ||
          message.includes("SSL") ||
          message.includes("TLS");

        if (isNetworkError) {
          console.log(`Network error detected for ${url}: ${message}`);
          // 可以在这里添加网络诊断逻辑
        }

        logFailure({
          operation,
          url,
          status: null,
          requestBody: payload,
          responseBody: message,
        });
        throw error;
      }
    };

    // Try image generation endpoints
    const tryImageGeneration = async () => {
      const payloads = buildImagePayloads();
      let shouldForceChat = false;
      let hasTriedSafePrompt = false;

      // 检查是否使用多模态模型
      const isUsingMultimodalModel = isMultimodalModel(imageModel);
      console.log("Model analysis:", {
        imageModel,
        isUsingMultimodalModel,
        shouldSkipImageEndpoint
      });

      // 如果使用多模态模型，直接跳转到聊天路径
      if (isUsingMultimodalModel) {
        console.log("Detected multimodal model, switching to chat path for image generation");
        return { base64: "", shouldForceChat: true };
      }

      for (const payload of payloads) {
        const { res, data, rawText } = await fetchJson(
          imageEndpoint,
          payload,
          "images/generations",
        );
        if (res.ok) {
          const b64 = await extractBase64(data);
          if (b64) {
            return { base64: b64, shouldForceChat: false };
          }
          logFailure({
            operation: "images/generations",
            url: imageEndpoint,
            status: res.status,
            requestBody: payload,
            responseBody: rawText || data,
          });
        } else {
          // 检查是否是内容策略错误
          if (isContentPolicyError(data, rawText) && !hasTriedSafePrompt) {
            hasTriedSafePrompt = true;
            // 使用安全提示词重试
            const safePrompt = generateSafePrompt(prompt);
            const safePayload = { ...payload, prompt: safePrompt };

            try {
              const { res: safeRes, data: safeData, rawText: safeRawText } = await fetchJson(
                imageEndpoint,
                safePayload,
                "images/generations",
              );

              if (safeRes.ok) {
                const b64 = await extractBase64(safeData);
                if (b64) {
                  // 记录成功使用了安全提示词
                  console.log(`Content policy error resolved using safe prompt: "${safePrompt}"`);
                  return { base64: b64, shouldForceChat: false };
                }
              }
            } catch (error) {
              console.log("Safe prompt retry failed:", error);
            }
          }

          if (shouldForceChatFromError(res.status, data, rawText)) {
            shouldForceChat = true;
          }
          logFailure({
            operation: "images/generations",
            url: imageEndpoint,
            status: res.status,
            requestBody: payload,
            responseBody: rawText || data,
          });
          if (shouldForceChat) break;
          if (res.status === 429) {
            await sleep(1200);
            continue;
          }
        }
      }
      return { base64: "", shouldForceChat };
    };

    // Try chat (multimodal) as fallback
    const tryChatGeneration = async () => {
      const payloads = buildChatPayloads();
      const url = `${baseUrl}/chat/completions`;

      console.log("Attempting chat-based image generation with payloads:", payloads.length);

      for (const payload of payloads) {
        const { res, data, rawText } = await fetchJson(
          url,
          payload,
          "chat/completions",
        );
        if (res.ok) {
          // 首先尝试从标准图片响应格式提取
          let b64 = await extractBase64(data);

          // 如果没有找到，尝试从聊天响应中提取图片
          if (!b64) {
            b64 = await extractImagesFromChatResponse(data);
          }

          if (b64) {
            console.log("Successfully extracted image from chat response");
            return b64;
          }

          logFailure({
            operation: "chat/completions",
            url,
            status: res.status,
            requestBody: payload,
            responseBody: rawText || data,
          });
        } else {
          logFailure({
            operation: "chat/completions",
            url,
            status: res.status,
            requestBody: payload,
            responseBody: rawText || data,
          });
          if (res.status === 429) {
            await sleep(1200);
            continue;
          }
        }
      }
      return "";
    };

    // Try edit if input/mask provided
    const tryEdit = async () => {
      if (!inputImage && !maskImage) return "";
      const form = buildEditForm();
      const url = `${baseUrl}/images/edits`;
      const res = await queuedFetch(url, {
        method: "POST",
        headers: buildOpenAiHeaders(apiKey, false, openAiAuthHeader),
        body: form,
        signal: controller.signal,
      });
      const rawText = await res.text().catch(() => "");
      let data: any = {};
      if (rawText) {
        try {
          data = JSON.parse(rawText);
        } catch {
          data = {};
        }
      }
      if (res.ok) {
        const b64 = await extractBase64(data);
        if (b64) return b64;
        logFailure({
          operation: "images/edits",
          url,
          status: res.status,
          requestBody: {
            model: imageModel,
            prompt,
            size,
            response_format: "b64_json",
            hasImage: !!inputImage,
            hasMask: !!maskImage,
            imageBytes: inputImage?.data?.length || 0,
            maskBytes: maskImage?.data?.length || 0,
          },
          responseBody: rawText || data,
        });
        return "";
      }
      logFailure({
        operation: "images/edits",
        url,
        status: res.status,
        requestBody: {
          model: imageModel,
          prompt,
          size,
          response_format: "b64_json",
          hasImage: !!inputImage,
          hasMask: !!maskImage,
          imageBytes: inputImage?.data?.length || 0,
          maskBytes: maskImage?.data?.length || 0,
        },
        responseBody: rawText || data,
      });
      return "";
    };

    let imageBase64 = "";
    let preferChat = forceChatImage || shouldSkipImageEndpoint;
    let didTryChat = false;
    if (inputImage || maskImage) {
      imageBase64 = await tryEdit();
    }
    if (!imageBase64) {
      if (preferChat) {
        imageBase64 = await tryChatGeneration();
        didTryChat = true;
      } else {
        const result = await tryImageGeneration();
        imageBase64 = result.base64;
        if (!imageBase64 && result.shouldForceChat) {
          preferChat = true;
        }
      }
    }
    if (!imageBase64 && preferChat && !didTryChat) {
      imageBase64 = await tryChatGeneration();
    }

    if (totalTimeout) {
      clearTimeout(totalTimeout);
      totalTimeout = null;
    }
    if (controller && !controller.signal.aborted) {
      controller.abort();
      controller = null;
    }

    if (!imageBase64) {
      return NextResponse.json(
        {
          error: "OpenAI-compatible image generation failed: no image returned.",
          details: "The API request completed successfully but no image data was found in the response.",
          suggestion: "Please check your model configuration and try again."
        },
        { status: 502, headers: noStoreHeaders() }
      );
    }

    // Debug: Log image data info
    console.log("Image generation successful:", {
      imageBase64Length: imageBase64.length,
      imageBase64Sample: imageBase64.substring(0, 100),
      isValidBase64: /^[A-Za-z0-9+/=]+$/.test(imageBase64)
    });

    // 🔧 FIX: 记录用量（所有路径的最终出口）
    await recordBuiltInUsageIfNeeded(
      useBuiltInService,
      userId,
      undefined,
      true,
      getElapsedMs()
    );

    return NextResponse.json(
      { imageBase64 },
      { headers: noStoreHeaders() }
    );
  } catch (error) {
    // 确保清理超时和控制器
    if (totalTimeout) {
      clearTimeout(totalTimeout);
      totalTimeout = null;
    }
    if (controller && !controller.signal.aborted) {
      controller.abort();
      controller = null;
    }

    const message =
      error instanceof Error ? error.message : "Failed to generate image.";

    // 改进错误消息，区分不同类型的错误
    let errorMessage = message;
    let statusCode = 500;

    if (error instanceof Error && error.name === 'AbortError') {
      errorMessage = "Request timeout. The image generation took too long to complete (over 180 seconds).";
      statusCode = 408; // Request Timeout
    } else if (message.includes("aborted") || message.includes("AbortError")) {
      errorMessage = "Request timeout. The image generation took too long to complete.";
      statusCode = 408;
    } else if (message.includes("fetch failed")) {
      errorMessage = "Network connection failed. Please check your internet connection and API endpoint.";
      statusCode = 502; // Bad Gateway
    } else if (message.includes("ENOTFOUND")) {
      errorMessage = "API endpoint not found. Please check your base URL configuration.";
      statusCode = 502;
    } else if (message.includes("ECONNREFUSED")) {
      errorMessage = "Connection refused by the API server. Please check if the service is running.";
      statusCode = 502;
    } else if (message.includes("certificate") || message.includes("SSL") || message.includes("TLS")) {
      errorMessage = "SSL/TLS certificate error. Please check your connection security settings.";
      statusCode = 502;
    } else if (message.includes("401") || message.includes("unauthorized")) {
      errorMessage = "Authentication failed. Please check your API key.";
      statusCode = 401;
    } else if (message.includes("403") || message.includes("forbidden")) {
      errorMessage = "Access forbidden. Please check your API permissions.";
      statusCode = 403;
    } else if (message.includes("429") || message.includes("rate limit")) {
      errorMessage = "Rate limit exceeded. Please wait and try again later.";
      statusCode = 429;
    } else if (message.includes("500") && message.includes("This operation was aborted")) {
      // 特殊处理：后端已经处理但前端认为是中断的情况
      errorMessage = "Request processing completed on server but response was interrupted. Please check if the image was generated successfully.";
    }

    console.error("Image generation error:", {
      originalMessage: message,
      errorType: error instanceof Error ? error.name : typeof error,
      stack: error instanceof Error ? error.stack : undefined,
      finalMessage: errorMessage,
      statusCode
    });

    return NextResponse.json(
      {
        error: errorMessage,
        originalError: message,
        errorType: error instanceof Error ? error.name : 'Unknown',
        timestamp: new Date().toISOString()
      },
      { status: statusCode, headers: noStoreHeaders() }
    );
  }
}
