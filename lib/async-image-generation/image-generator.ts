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
} from "@/lib/image-generation/shared-utils";

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
  const timeout = setTimeout(() => controller.abort(), 180000); // 180 seconds for slow APIs

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

  // Try compatibility system first
  try {
    const response = await generateImageWithCompatibility(
      prompt,
      apiKey,
      baseUrl,
      {
        model,
        size: pickOpenAiImageSize(aspectRatio),
        response_format: responseFormat,
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
      const imageBase64 = image.b64_json || image.url;

      if (imageBase64) {
        // If it's a URL, fetch and convert to base64
        if (typeof imageBase64 === "string" && imageBase64.startsWith("http")) {
          const res = await queuedFetch(imageBase64, {
            signal: AbortSignal.timeout(30000)
          }, 'low');
          if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer());
            return buf.toString("base64");
          }
        }
        return imageBase64;
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

  const payload: any = {
    model,
    prompt,
    n: 1,
    response_format: responseFormat !== "auto" ? responseFormat : "b64_json",
  };

  if (imageSize && /^\d+x\d+$/i.test(imageSize)) {
    payload.size = imageSize;
  } else {
    payload.size = size;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const res = await queuedFetch(endpoint, {
      method: "POST",
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
        throw new Error("Failed to parse response");
      }
    }

    if (!res.ok) {
      const errorMsg = data?.error?.message || data?.error || "Image generation failed";
      throw new Error(errorMsg);
    }

    const imageBase64 = await extractBase64(data);
    if (!imageBase64) {
      throw new Error("No image data in response");
    }

    return imageBase64;
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

  // Create timeout promise (180 seconds - extended for slow APIs like Nano Banana Pro)
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error('Task timeout after 180 seconds'));
    }, 180000);
  });

  // Create generation promise
  const generationPromise = (async () => {
    try {
      let imageBase64: string;

      // Check if model is a multimodal model that requires chat endpoint
      const model = params.openAiImageModel || params.geminiImageModel || '';
      const usesChatEndpoint = isMultimodalModel(model);

      console.log('[ImageGenerator] Model analysis:', {
        model,
        provider: params.provider,
        usesChatEndpoint,
      });

      if (params.provider === 'gemini' || params.provider === 'gemini_compat') {
        imageBase64 = await generateWithGemini(params);
      } else if (params.provider === 'openai') {
        // For multimodal models or when standard image API fails, use chat endpoint
        if (usesChatEndpoint) {
          console.log('[ImageGenerator] Using chat endpoint for multimodal model:', model);
          imageBase64 = await generateWithChat(params);
        } else {
          // Try standard image API first, fallback to chat if it fails
          try {
            imageBase64 = await generateWithOpenAI(params);
          } catch (standardError) {
            console.log('[ImageGenerator] Standard image API failed, trying chat endpoint:',
              standardError instanceof Error ? standardError.message : 'Unknown error');
            imageBase64 = await generateWithChat(params);
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
        errorMessage: 'Task timeout after 60 seconds',
      });
    }
    // If it's a generation error, it's already handled in generationPromise
  }
}

/**
 * Check if a task has expired (older than 60 seconds and not completed)
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
