/**
 * Shared Utilities for Image Generation
 * Common functions used by both route.ts and image-generator.ts
 */

import {
    MaskReferenceImage,
    MaskReferenceMode,
    RawReferenceImage,
    StyleReferenceImage,
} from "@google/genai";
import { queuedFetch } from "@/lib/request-queue-manager";

// ==================== Type Definitions ====================

export type InlineImage = {
    data: string;
    mimeType: string;
};

export type Provider = "openai" | "gemini" | "gemini_compat";
export type ImageResponseFormat = "auto" | "b64_json" | "base64" | "url";

// ==================== Image Conversion Utilities ====================

/**
 * Convert InlineImage to Gemini inline part format
 */
export const toInlinePart = (img: InlineImage) => ({
    inlineData: { mimeType: img.mimeType, data: img.data },
});

/**
 * Convert InlineImage to Gemini image format
 */
export const toGeminiImage = (img: InlineImage) => ({
    imageBytes: img.data,
    mimeType: img.mimeType,
});

// ==================== Gemini Response Extraction ====================

/**
 * Extract generated image from Gemini response
 */
export const extractGeminiGeneratedImage = (response: any): string =>
    response?.generatedImages?.[0]?.image?.imageBytes || "";

/**
 * Extract inline image data from Gemini response
 */
export const extractGeminiInlineImage = (response: any): string => {
    for (const part of response?.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData?.data) {
            return part.inlineData.data as string;
        }
    }
    return "";
};

// ==================== Model Detection Utilities ====================

/**
 * Check if model should use Gemini preview API
 */
export const shouldUseGeminiPreviewModel = (model: string): boolean =>
    /preview/i.test(model);

/**
 * Check if model should use Gemini Alpha API
 */
export const shouldUseGeminiAlpha = (model: string): boolean =>
    /preview|exp|experimental|alpha/i.test(model);

/**
 * Check if a model is a known multimodal model that should use chat API
 */
export const isMultimodalModel = (model: string): boolean => {
    if (!model) return false;
    const multimodalPatterns = [
        /gpt-?4/i,
        /gpt-?4o/i,
        /gemini.*pro/i,
        /gemini.*1\\.5/i,
        /gemini.*2\\.0/i,
        /gemini.*3/i,          // Gemini 3 models
        /gemini.*flash/i,
        /gemini.*ultra/i,
        /gemini.*preview/i, // Nano Banana Pro compatible models
        /claude/i,
        /llava/i,
        /qwen.*vl/i,
        /cogvlm/i,
        /yi.*vl/i,
        /internlm.*vl/i,
        /deepseek.*vl/i,
        /-vl/i
    ];
    return multimodalPatterns.some(pattern => pattern.test(model));
};

// ==================== Reference Image Builder ====================

/**
 * Build Gemini reference images array from input, mask, and style reference images
 */
export const buildGeminiReferenceImages = (
    inputImage: InlineImage | undefined,
    maskImage: InlineImage | undefined,
    referenceImages: InlineImage[] = []
): Array<RawReferenceImage | MaskReferenceImage | StyleReferenceImage> => {
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

// ==================== Response Format Normalization ====================

/**
 * Normalize image response format to standard values
 */
export const normalizeImageResponseFormat = (value: any): ImageResponseFormat => {
    const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (raw === "b64_json" || raw === "base64" || raw === "url") return raw;
    return "auto";
};

// ==================== URL Collection ====================

/**
 * Collect image URLs from text content
 * Supports markdown format, direct URLs, and API-specific patterns
 */
export const collectImageUrlsFromText = (text: string, urls: Set<string>): void => {
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
    const zeaburRegex = /(https?:\/\/[^\s)]*zeabur\.app\/images\/[^\s)]+)/gi;
    match = zeaburRegex.exec(text);
    while (match) {
        const url = match[1].replace(/[)\]]+$/, '');
        urls.add(url);
        match = zeaburRegex.exec(text);
    }

    // Pattern 4: Generic image API URLs
    const imageApiRegex = /(https?:\/\/(?:images\.|img\.|cdn\.)[^\s)]+)/gi;
    match = imageApiRegex.exec(text);
    while (match) {
        const url = match[1].replace(/[)\]]+$/, '');
        urls.add(url);
        match = imageApiRegex.exec(text);
    }
};

/**
 * Collect image URLs from various content formats (string, array, object)
 */
export const collectImageUrlsFromContent = (content: any, urls: Set<string>): void => {
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

// ==================== Base64 Extraction ====================

/**
 * Extract base64 image data from API response
 * Supports multiple response formats from different providers
 */
export const extractBase64FromResponse = async (data: any): Promise<string> => {
    console.log("[SharedUtils] Extracting base64 from response:", {
        hasData: !!data?.data,
        dataLength: Array.isArray(data?.data) ? data.data.length : 0,
        firstDataItem: data?.data?.[0] ? Object.keys(data.data[0]) : [],
        hasImages: !!data?.images,
    });

    // Try different field combinations for various providers
    const tryFields = [
        // Standard OpenAI format
        data?.data?.[0]?.b64_json,
        data?.data?.[0]?.b64,
        data?.data?.[0]?.base64,
        // Alternative formats
        data?.data?.[0]?.image_base64,
        data?.data?.[0]?.image,
        // Other provider formats
        data?.images?.[0]?.b64_json,
        data?.images?.[0]?.base64,
        data?.base64,
        data?.b64_json,
        // Result wrappers
        data?.result?.b64_json,
        data?.result?.base64,
    ];

    for (const val of tryFields) {
        if (typeof val === "string" && val.trim() && val.length > 100) {
            const trimmed = val.trim();
            // Check for valid base64 characters
            if (/^[A-Za-z0-9+/=\s\n\r\-_]+$/.test(trimmed)) {
                const cleanBase64 = trimmed.replace(/[\s\n\r\-_]/g, '');
                if (cleanBase64.length > 100 && /^[A-Za-z0-9+/=]+$/.test(cleanBase64)) {
                    console.log("[SharedUtils] Found valid base64 data, length:", cleanBase64.length);
                    return cleanBase64;
                }
            }

            // Check for data URL format
            if (trimmed.startsWith('data:image/')) {
                const base64Part = trimmed.split(',')[1];
                if (base64Part && base64Part.length > 100) {
                    console.log("[SharedUtils] Found data URL, extracting base64");
                    return base64Part.trim();
                }
            }
        }
    }

    // Try URL extraction and fetch
    const urls = new Set<string>();
    const directUrl = data?.data?.[0]?.url || data?.url || data?.images?.[0]?.url || data?.result?.url || "";
    if (typeof directUrl === "string" && directUrl) {
        urls.add(directUrl);
    }

    // Extract from message content
    const message = data?.choices?.[0]?.message;
    const delta = data?.choices?.[0]?.delta;
    if (message?.content) {
        collectImageUrlsFromContent(message.content, urls);
    }
    if (delta?.content) {
        collectImageUrlsFromContent(delta.content, urls);
    }

    // Try fetching URLs
    for (const url of urls) {
        if (typeof url !== "string" || !url.trim()) continue;

        if (url.startsWith("data:image/")) {
            const base64Part = url.split(',')[1];
            if (base64Part && base64Part.length > 100) {
                console.log("[SharedUtils] Found data URL in urls set");
                return base64Part.trim();
            }
            continue;
        }

        if (url.startsWith("http")) {
            try {
                console.log("[SharedUtils] Fetching image from URL:", url);
                const res = await queuedFetch(url, {
                    signal: AbortSignal.timeout(30000)
                }, 'low');
                if (res.ok) {
                    const buf = Buffer.from(await res.arrayBuffer());
                    const base64 = buf.toString("base64");
                    console.log("[SharedUtils] Converted URL to base64, length:", base64.length);
                    return base64;
                }
            } catch (error) {
                console.log("[SharedUtils] Failed to fetch URL:", url, error);
            }
        }
    }

    return "";
};

// ==================== Error Detection ====================

/**
 * Check if error message indicates image endpoint is not supported
 */
export const isImageEndpointError = (error: string): boolean => {
    const combined = error.toLowerCase().trim();
    const imageEndpointErrors = [
        "not supported",
        "endpoint not found",
        "no such endpoint",
        "invalid_endpoint",
        "unknown_endpoint",
        "endpoint_not_available",
        "image generation is not available",
        "this model does not support image generation",
        "not_implemented",
        "openai_error",
        "invalid endpoint",
        "unsupported endpoint"
    ];
    return imageEndpointErrors.some(err => combined.includes(err));
};

/**
 * Check if error is a content policy violation
 */
export const isContentPolicyError = (error: string): boolean => {
    const combined = error.toLowerCase().trim();
    const policyErrors = [
        "content policy",
        "safety",
        "harmful",
        "inappropriate",
        "violates",
        "not allowed",
        "blocked"
    ];
    return policyErrors.some(err => combined.includes(err));
};

// ==================== Image Value Coercion (URL → Base64) ====================

/**
 * 把上游图像生成接口可能返回的多种"图片值"统一规整为纯 base64 字符串。
 *
 * 触发背景（用户报告的"破坏缩略图 / 当前页生成失败"症状根因）:
 *   gpt-image-2 等兼容服务即使请求 response_format=b64_json 也常常返回
 *   `{ data: [{ url: "https://..." }] }`。旧逻辑 `image.b64_json || image.url`
 *   把远程 URL 当作 imageBase64 字段透传给客户端，客户端 normalizer 识别到
 *   https:// 直接当 <img src=...>，但远程 URL：
 *     - 短时签名过期（OpenAI / Azure 默认 1h，再加上代理转发的延迟）
 *     - CORS / 防盗链拒绝桌面端 Electron renderer 加载
 *     - 临时存储清理 / 网络抖动
 *   任何一个失败都会触发 onError → "破坏缩略图"，或字段提取空 → "当前页生成失败"。
 *
 * 修复策略：统一在服务端把任何形式（base64 / data URL / http(s) URL / markdown
 * 嵌入）的图片值下载并转码为纯 base64，前端永远拿稳定的内联数据，不再依赖
 * 远程链接的生命周期。
 *
 * 入参可能形态：
 *   - 纯 base64：直接返回（去除空白）
 *   - data:image/...;base64,xxx：抽取 base64 部分
 *   - https://... 或 http://...：fetch 后转 base64
 *   - markdown ![](...)：抽取 URL 后递归
 *   - 空 / 失败：返回 ""
 */
export const coerceImageValueToBase64 = async (
    value: string | null | undefined,
    timeoutMs = 30000
): Promise<string> => {
    const raw = (value || "").trim();
    if (!raw) return "";

    // markdown image: ![](xxx)
    const md = raw.match(/!\[[^\]]*]\(([^)]+)\)/i);
    const extracted = (md?.[1] || raw).trim().replace(/^['"]|['"]$/g, "");
    if (!extracted) return "";

    // data URL → 抽 base64 部分
    if (/^data:image\//i.test(extracted)) {
        const comma = extracted.indexOf(",");
        if (comma >= 0) {
            const b64 = extracted.slice(comma + 1).replace(/[\s\n\r]/g, "");
            return b64;
        }
        return "";
    }

    // http(s) URL → 下载并 base64 化
    if (/^https?:\/\//i.test(extracted)) {
        try {
            const res = await queuedFetch(
                extracted,
                { signal: AbortSignal.timeout(timeoutMs) },
                "low"
            );
            if (!res.ok) {
                console.warn(
                    `[coerceImageValueToBase64] fetch ${extracted} -> HTTP ${res.status}`
                );
                return "";
            }
            const buf = Buffer.from(await res.arrayBuffer());
            return buf.toString("base64");
        } catch (err) {
            console.warn(
                `[coerceImageValueToBase64] fetch failed:`,
                err instanceof Error ? err.message : err
            );
            return "";
        }
    }

    // blob://、asset:// 等不可在服务端解析的协议 → 放弃
    if (/^[a-z]+:\/\//i.test(extracted)) {
        console.warn(
            `[coerceImageValueToBase64] unsupported scheme: ${extracted.substring(0, 80)}`
        );
        return "";
    }

    // 其他都按已经是纯 base64 字符串处理（清掉换行/空白）
    return extracted.replace(/[\s\n\r]/g, "");
};
