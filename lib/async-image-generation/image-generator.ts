/**
 * Image Generator for Async Image Generation
 * Handles asynchronous image generation with timeout control
 */

import { updateTaskStatus } from './task-manager';
import { GoogleGenAI } from "@google/genai";
import {
  defaultGeminiImageModel,
  defaultOpenAiImageModel,
  defaultOpenAiImageResponseFormat,
  buildOpenAiHeaders,
  normalizeOpenAiAuthHeader,
  normalizeGeminiBaseUrl,
  normalizeOpenAiBaseUrl,
  pickOpenAiImageSize,
  resolveOpenAiEndpoint,
  defaultOpenAiImageEndpointPath,
} from "@/lib/ai";
import {
  generateImageWithCompatibility,
  handleCompatibilityError,
} from "@/lib/api-compatibility/integration";
import { queuedFetch } from "@/lib/request-queue-manager";
import { extractOpenAiCompatibleError } from "@/lib/openai-compatible-response";

// Import shared utilities to eliminate code duplication
import {
  InlineImage,
  Provider,
  ImageResponseFormat,
  toInlinePart,
  toGeminiImage,
  extractGeminiGeneratedImage,
  extractGeminiInlineImage,
  shouldUseGeminiPreviewModel,
  shouldUseGeminiAlpha,
  buildGeminiReferenceImages,
  normalizeImageResponseFormat,
  extractBase64FromResponse,
  isMultimodalModel,
  resolveImageToBase64,
} from "@/lib/image-generation/shared-utils";
import { isLikelyOpenAiImageOnlyModel } from "@/lib/openai-model-capabilities";

/**
 * Parameters for image generation
 */
export interface GenerationParams {
  prompt: string;
  provider: Provider;
  model?: string;
  size?: string;
  quality?: string;
  style?: string;
  n?: number;
  apiKey?: string;
  baseUrl?: string;
  aspectRatio?: string;
  imageSize?: string;
  openAiImageModel?: string;
  openAiAuthHeader?: string;
  openAiImageEndpointPath?: string;
  openAiImageResponseFormat?: string;
  geminiApiKey?: string;
  geminiBaseUrl?: string;
  geminiImageModel?: string;
  inputImage?: InlineImage;
  maskImage?: InlineImage;
  referenceImages?: InlineImage[];
  providerId?: string;
  providerName?: string;
  [key: string]: any;
}

/**
 * Image Generator interface
 */
export interface ImageGenerator {
  generateAsync(taskId: string, params: GenerationParams): Promise<void>;
  isTaskExpired(taskId: string): Promise<boolean>;
}

// Use extractBase64FromResponse from shared-utils
const extractBase64 = extractBase64FromResponse;
const IMAGE_OPERATION_TIMEOUT_MS = 600000;
const IMAGE_OPERATION_TIMEOUT_SECONDS = IMAGE_OPERATION_TIMEOUT_MS / 1000;

const isGoogleGenerativeLanguageHost = (rawUrl?: string) => {
  try {
    const value = (rawUrl || "").trim();
    if (!value) return false;
    const normalized = normalizeGeminiBaseUrl(value);
    const url = new URL(normalized.baseUrl);
    return /(^|\.)generativelanguage\.googleapis\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
};

const isExplicitImageSize = (value?: string) =>
  typeof value === "string" && /^\d+x\d+$/i.test(value.trim());

const isLikelyBase64Payload = (value: string) => {
  const trimmed = value.replace(/\s+/g, "");
  if (trimmed.length < 128) return false;
  if (!/^[A-Za-z0-9+/=]+$/.test(trimmed)) return false;
  return trimmed.length % 4 === 0 || trimmed.endsWith("=") || trimmed.endsWith("==");
};

const parseDirectImageResponse = (rawText: string) => {
  const trimmed = rawText.trim();
  if (!trimmed) return {};

  try {
    return JSON.parse(trimmed);
  } catch {
    if (trimmed.startsWith("data:image/")) {
      const [, base64 = ""] = trimmed.split(",", 2);
      return {
        b64_json: base64,
        data: base64 ? [{ b64_json: base64 }] : [],
      };
    }

    if (/^https?:\/\//i.test(trimmed)) {
      return {
        url: trimmed,
        data: [{ url: trimmed }],
      };
    }

    if (isLikelyBase64Payload(trimmed)) {
      return {
        b64_json: trimmed.replace(/\s+/g, ""),
        data: [{ b64_json: trimmed.replace(/\s+/g, "") }],
      };
    }

    return {
      choices: [{ message: { content: trimmed } }],
    };
  }
};

const buildDirectOpenAiImagePayloads = (options: {
  baseUrl: string;
  model: string;
  prompt: string;
  responseFormat: ImageResponseFormat;
  size: string;
  imageSize?: string;
  imageOnlyModel: boolean;
}) => {
  const {
    baseUrl,
    model,
    prompt,
    responseFormat,
    size,
    imageSize,
    imageOnlyModel,
  } = options;
  const isModelGate = baseUrl.includes("mg.aid.pub");
  const resolvedSize = isExplicitImageSize(imageSize) ? imageSize!.trim() : size;
  const variants: any[] = [];
  const seen = new Set<string>();
  const pushVariant = (payload: any) => {
    const key = JSON.stringify(payload);
    if (seen.has(key)) return;
    seen.add(key);
    variants.push(payload);
  };

  if (isModelGate) {
    const basePayload = {
      model,
      prompt,
      number_results: 1,
      output_format: "png",
      output_type: "base64",
      size: resolvedSize,
    };
    pushVariant(basePayload);
    if (responseFormat !== "auto") {
      pushVariant({ ...basePayload, response_format: responseFormat });
    }
    return variants;
  }

  const basePayload: Record<string, unknown> = {
    model,
    prompt,
    n: 1,
    size: resolvedSize,
  };

  if (responseFormat !== "auto") {
    pushVariant({ ...basePayload, response_format: responseFormat });
  }

  const fallbackFormats = imageOnlyModel
    ? [undefined, "b64_json", "base64", "url"]
    : ["b64_json", "base64", "url", undefined];

  for (const format of fallbackFormats) {
    if (!format) {
      pushVariant({ ...basePayload });
      continue;
    }
    pushVariant({ ...basePayload, response_format: format });
  }

  return variants;
};

/**
 * Generate image using chat/completions endpoint (for multimodal models)
 * This is required for APIs like Zeabur/Nano Banana Pro that use chat API for image generation
 */
async function generateWithChat(params: GenerationParams): Promise<string> {
  const {
    prompt,
    apiKey,
    baseUrl: rawBaseUrl,
    openAiImageModel,
    openAiAuthHeader,
  } = params;

  if (!apiKey) {
    throw new Error("API key is required for chat-based image generation");
  }

  const baseUrl = normalizeOpenAiBaseUrl(rawBaseUrl);
  const model = openAiImageModel || 'gemini-2.0-flash-exp';
  const authHeader = normalizeOpenAiAuthHeader(openAiAuthHeader);

  // Build chat endpoint URL
  const chatEndpoint = `${baseUrl}/chat/completions`;
  console.log('[ImageGenerator] Using chat endpoint for image generation:', chatEndpoint);

  // Prepare chat payload with image generation instruction
  const payload = {
    model,
    messages: [
      {
        role: 'user',
        content: `Generate a high-quality image based on this description. Output ONLY the image without any text explanation:\n\n${prompt}`
      }
    ],
    max_tokens: 4096
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_OPERATION_TIMEOUT_MS); // 600 seconds for slow APIs

  try {
    console.log('[ImageGenerator] Sending chat request for image generation...');
    const res = await queuedFetch(chatEndpoint, {
      method: 'POST',
      headers: buildOpenAiHeaders(apiKey, true, authHeader),
      body: JSON.stringify(payload),
      signal: controller.signal,
    }, 'high');

    const rawText = await res.text();
    let data: any = {};

    if (rawText) {
      try {
        data = JSON.parse(rawText);
      } catch {
        throw new Error('Failed to parse chat response');
      }
    }

    if (!res.ok) {
      const errorMsg = data?.error?.message || data?.error || 'Chat image generation failed';
      throw new Error(errorMsg);
    }

    console.log('[ImageGenerator] Chat response received, extracting image...');

    // Extract image from chat response using shared utility
    const imageBase64 = await extractBase64(data);
    if (!imageBase64) {
      throw new Error('No image found in chat response');
    }

    console.log('[ImageGenerator] Image extracted successfully from chat response');
    return imageBase64;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Generate image using Gemini provider
 */
async function generateWithGemini(params: GenerationParams): Promise<string> {
  const {
    prompt,
    geminiApiKey,
    geminiBaseUrl,
    geminiImageModel,
    aspectRatio = "1:1",
    imageSize,
    inputImage,
    maskImage,
    referenceImages = [],
  } = params;

  if (!geminiApiKey) {
    throw new Error("Gemini API key is required");
  }

  const baseConfig = geminiBaseUrl ? normalizeGeminiBaseUrl(geminiBaseUrl) : null;
  const model = geminiImageModel || defaultGeminiImageModel;

  // Initialize Gemini AI client
  const apiVersion = shouldUseGeminiAlpha(model) ? "v1alpha" : baseConfig?.apiVersion;
  const aiOptions: any = {
    apiKey: geminiApiKey,
    ...(apiVersion ? { apiVersion } : {}),
  };
  if (baseConfig?.baseUrl) {
    aiOptions.httpOptions = { baseUrl: baseConfig.baseUrl, apiVersion };
  }
  const ai = new GoogleGenAI(aiOptions);
  const usePreviewModel = shouldUseGeminiPreviewModel(model);

  const config: any = {
    referenceImages: buildGeminiReferenceImages(inputImage, maskImage, referenceImages),
  };

  if (usePreviewModel) {
    const parts: any[] = [];
    if (inputImage) parts.push(toInlinePart(inputImage));
    if (maskImage) parts.push(toInlinePart(maskImage));
    for (const img of referenceImages) {
      parts.push(toInlinePart(img));
    }
    parts.push({ text: prompt });

    const response = await ai.models.generateContent({
      model,
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
      throw new Error("No image generated from Gemini");
    }
    return imageBase64;
  }

  const response = await ai.models.generateImages({
    model,
    prompt,
    config,
  });

  const imageBase64 = extractGeminiGeneratedImage(response);
  if (!imageBase64) {
    throw new Error("No image generated from Gemini");
  }

  return imageBase64;
}

/**
 * Generate image using OpenAI-compatible provider
 */
async function generateWithOpenAI(params: GenerationParams): Promise<string> {
  const {
    prompt,
    apiKey,
    baseUrl: rawBaseUrl,
    openAiImageModel,
    openAiAuthHeader,
    openAiImageEndpointPath,
    openAiImageResponseFormat,
    aspectRatio = "1:1",
    imageSize,
    providerId,
    providerName,
  } = params;

  if (!apiKey) {
    throw new Error("API key is required");
  }

  const baseUrl = normalizeOpenAiBaseUrl(rawBaseUrl);
  const model = openAiImageModel || defaultOpenAiImageModel;
  const authHeader = normalizeOpenAiAuthHeader(openAiAuthHeader);
  const endpointPath = openAiImageEndpointPath || defaultOpenAiImageEndpointPath;
  const responseFormat = normalizeImageResponseFormat(
    openAiImageResponseFormat || defaultOpenAiImageResponseFormat
  );
  const imageOnlyModel = isLikelyOpenAiImageOnlyModel(model);

  // Try compatibility system first
  try {
    const response = await generateImageWithCompatibility(
      prompt,
      apiKey,
      baseUrl,
      {
        model,
        size: pickOpenAiImageSize(aspectRatio),
        response_format: responseFormat === "auto" ? undefined : responseFormat,
        n: 1,
        authType: (() => {
          if (authHeader === "authorization") return "bearer";
          if (authHeader === "x-api-key") return "api_key";
          return "custom_header";
        })(),
        providerId,
        providerName,
      }
    );

    if (response.images && response.images.length > 0) {
      const image = response.images[0];
      // 🔧 FIX (gpt-image-2 显示成功但破图):
      // 之前 `image.b64_json || image.url` 在 b64_json 损坏或 URL 拉取失败时
      // 会把 URL 字符串塞进 imageBase64 → 渲染端拼 data:image/png;base64,https://... 破图。
      // 现在统一走 resolveImageToBase64：先校验 b64，URL 强制下载，全部失败则 throw，
      // 让外层 catch 走 fallback 路径，不再把脏数据透传。
      try {
        const imageBase64 = await resolveImageToBase64(image);
        if (imageBase64) {
          return imageBase64;
        }
      } catch (resolveError) {
        console.warn(
          '[AsyncImage] Compatibility response could not be resolved to base64, falling through to direct API:',
          resolveError instanceof Error ? resolveError.message : resolveError
        );
        // fall through to fallback below
      }
    }
  } catch (compatibilityError) {
    console.log('Compatibility system failed, trying fallback:', compatibilityError);

    const errorInfo = handleCompatibilityError(compatibilityError);
    if (!errorInfo.canRetry) {
      throw new Error(errorInfo.userMessage);
    }
  }

  // Fallback to direct API call
  const endpoint = resolveOpenAiEndpoint(baseUrl, endpointPath);
  const size = pickOpenAiImageSize(aspectRatio);

  const payloads = buildDirectOpenAiImagePayloads({
    baseUrl,
    model,
    prompt,
    responseFormat,
    size,
    imageSize,
    imageOnlyModel,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_OPERATION_TIMEOUT_MS); // 600 seconds for slow APIs

  try {
    const errors: string[] = [];

    for (const payload of payloads) {
      const res = await queuedFetch(endpoint, {
        method: "POST",
        headers: buildOpenAiHeaders(apiKey, true, authHeader),
        body: JSON.stringify(payload),
        signal: controller.signal,
      }, 'high');

      const rawText = await res.text();
      const data = parseDirectImageResponse(rawText);
      const envelopeError = extractOpenAiCompatibleError(data);

      if (!res.ok) {
        const errorMsg =
          data?.error?.message ||
          data?.error ||
          rawText ||
          `Image generation failed with status ${res.status}`;
        errors.push(String(errorMsg));
        continue;
      }

      if (envelopeError) {
        errors.push(envelopeError);
        continue;
      }

      const imageBase64 = await extractBase64(data);
      if (imageBase64) {
        return imageBase64;
      }

      errors.push(rawText ? "No image data in response" : "Empty response from image API");
    }

    throw new Error(errors[errors.length - 1] || "Image generation failed");
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Asynchronously generate an image
 * This function runs in the background and updates task status
 * 
 * @param taskId - Task ID to update
 * @param params - Generation parameters
 */
export async function generateAsync(
  taskId: string,
  params: GenerationParams
): Promise<void> {
  console.log('[ImageGenerator] Starting async generation:', {
    taskId,
    provider: params.provider,
    prompt: params.prompt.substring(0, 50) + '...',
  });

  // Update status to processing
  try {
    await updateTaskStatus(taskId, 'processing');
  } catch (error) {
    console.error('[ImageGenerator] Failed to update status to processing:', error);
    // Continue anyway, the generation might still succeed
  }

  // Create timeout promise (600 seconds - extended for slow APIs like Nano Banana Pro)
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Task timeout after ${IMAGE_OPERATION_TIMEOUT_SECONDS} seconds`));
    }, IMAGE_OPERATION_TIMEOUT_MS);
  });

  // Create generation promise
  const generationPromise = (async () => {
    try {
      let imageBase64: string;

      // Only route to chat when explicitly configured.
      // A multimodal-looking model name does not guarantee chat-based image generation.
      const model = params.openAiImageModel || params.geminiImageModel || '';
      const usesChatEndpoint =
        params.openAiForceChatImage === true ||
        /\/chat\/completions\b/i.test(String(params.openAiImageEndpointPath || ""));
      const modelLooksMultimodal = isMultimodalModel(model);
      const imageOnlyModel = isLikelyOpenAiImageOnlyModel(model);

      console.log('[ImageGenerator] Model analysis:', {
        model,
        provider: params.provider,
        usesChatEndpoint,
        modelLooksMultimodal,
        imageOnlyModel,
      });

      const explicitGeminiBaseUrl = String(params.geminiBaseUrl || params.baseUrl || '').trim();
      const shouldUseNativeGemini =
        (params.provider === 'gemini' &&
          (!explicitGeminiBaseUrl || isGoogleGenerativeLanguageHost(explicitGeminiBaseUrl))) ||
        (params.provider === 'gemini_compat' &&
          isGoogleGenerativeLanguageHost(explicitGeminiBaseUrl));

      if (shouldUseNativeGemini) {
        imageBase64 = await generateWithGemini(params);
      } else if (
        params.provider === 'openai' ||
        params.provider === 'gemini_compat' ||
        params.provider === 'gemini'
      ) {
        const openAiParams: GenerationParams =
          params.provider === 'gemini_compat' || params.provider === 'gemini'
            ? {
                ...params,
                provider: 'openai',
                apiKey: params.apiKey || params.geminiApiKey,
                baseUrl: params.baseUrl || params.geminiBaseUrl,
                openAiImageModel:
                  params.openAiImageModel || params.geminiImageModel || params.model,
              }
            : params;
        if (
          (params.provider === 'gemini_compat' || params.provider === 'gemini') &&
          !String(openAiParams.baseUrl || "").trim()
        ) {
          throw new Error("Missing geminiCompatBaseUrl/baseUrl for OpenAI-compatible image generation.");
        }
        // Use chat only when the user/provider explicitly configured a chat image route.
        if (usesChatEndpoint) {
          console.log('[ImageGenerator] Using explicitly configured chat endpoint for image generation:', model);
          imageBase64 = await generateWithChat(openAiParams);
        } else {
          // Try standard image API first, fallback to chat if it fails
          try {
            imageBase64 = await generateWithOpenAI(openAiParams);
          } catch (standardError) {
            const errorMessage =
              standardError instanceof Error ? standardError.message : 'Unknown error';
            if (imageOnlyModel) {
              console.log('[ImageGenerator] Standard image API failed for image-only model; skipping chat fallback:', errorMessage);
              throw standardError;
            }
            console.log('[ImageGenerator] Standard image API failed, trying chat endpoint:', errorMessage);
            imageBase64 = await generateWithChat(openAiParams);
          }
        }
      } else {
        throw new Error(`Unsupported provider: ${params.provider}`);
      }

      // Update task status to completed with result
      await updateTaskStatus(taskId, 'completed', {
        resultImage: imageBase64,
      });

      console.log('[ImageGenerator] Generation completed successfully:', taskId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[ImageGenerator] Generation failed:', {
        taskId,
        error: errorMessage,
      });

      // Update task status to failed with error
      await updateTaskStatus(taskId, 'failed', {
        errorMessage,
      });
    }
  })();

  // Race between generation and timeout
  try {
    await Promise.race([generationPromise, timeoutPromise]);
  } catch (error) {
    // If timeout occurred, update task status
    if (error instanceof Error && error.message.includes('timeout')) {
      console.error('[ImageGenerator] Task timeout:', taskId);
      await updateTaskStatus(taskId, 'failed', {
        errorMessage: `Task timeout after ${IMAGE_OPERATION_TIMEOUT_SECONDS} seconds`,
      });
    }
    // If it's a generation error, it's already handled in generationPromise
  }
}

/**
 * Check if a task has expired
 * 
 * @param taskId - Task ID to check
 * @returns True if task is expired
 */
export async function isTaskExpired(taskId: string): Promise<boolean> {
  // This is a placeholder - in a real implementation, you would query the database
  // For now, we rely on the timeout mechanism in generateAsync
  return false;
}

/**
 * Default image generator implementation
 */
export const imageGenerator: ImageGenerator = {
  generateAsync,
  isTaskExpired,
};
