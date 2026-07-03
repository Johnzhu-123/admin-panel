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
import { normalizeBase64Payload } from "@/lib/image-generation/response-url";

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
        /gemini.*image/i,
        /gemini.*imagen/i,
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

// ==================== Base64 Sanitization & Remote Fetch ====================

/**
 * 校验下载到的 buffer 是否带可识别的图像 magic bytes。
 *
 * gpt-image-2 / DALL·E 的 Azure Blob URL 在限流 / URL 过期 / CORS 拒绝时可能返回：
 *   - HTTP 200 + `text/html` 错误页（XML/JSON 错误体）
 *   - HTTP 200 + 空 body
 *   - 短小的 placeholder 图片
 * 这些都会被原始 `buffer.toString("base64")` 当作合法 base64 透传到客户端，
 * 渲染端拼 data URL 后就是「破损缩略图」。这里强制按文件头识别 PNG/JPEG/GIF/WebP/BMP/AVIF，
 * 不通过的一律视为下载失败。
 */
export const isLikelyImageBuffer = (buffer: Buffer): boolean => {
    if (!buffer || buffer.length < 16) return false;

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47 &&
        buffer[4] === 0x0d &&
        buffer[5] === 0x0a &&
        buffer[6] === 0x1a &&
        buffer[7] === 0x0a
    ) {
        return true;
    }
    // JPEG: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return true;
    }
    // GIF: "GIF87a" / "GIF89a"
    if (
        buffer[0] === 0x47 &&
        buffer[1] === 0x49 &&
        buffer[2] === 0x46 &&
        buffer[3] === 0x38 &&
        (buffer[4] === 0x37 || buffer[4] === 0x39) &&
        buffer[5] === 0x61
    ) {
        return true;
    }
    // WebP: "RIFF" .... "WEBP"
    if (
        buffer[0] === 0x52 &&
        buffer[1] === 0x49 &&
        buffer[2] === 0x46 &&
        buffer[3] === 0x46 &&
        buffer[8] === 0x57 &&
        buffer[9] === 0x45 &&
        buffer[10] === 0x42 &&
        buffer[11] === 0x50
    ) {
        return true;
    }
    // BMP: "BM"
    if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
        return true;
    }
    // AVIF / HEIC: bytes 4-7 == "ftyp" + brand at 8-11
    if (
        buffer[4] === 0x66 &&
        buffer[5] === 0x74 &&
        buffer[6] === 0x79 &&
        buffer[7] === 0x70
    ) {
        return true;
    }
    return false;
};

/**
 * 校验 base64 图片负载，过滤明显损坏的内容（URL / HTML / 截断负载）。
 * 返回标准 base64 字符串（去除 URL-safe 字符），不可用时返回空字符串。
 *
 * 与 app/api/ai/image/route.ts 和 lib/built-in-api-service/components/api-proxy-layer.ts
 * 保持同语义 —— 三处必须一致，避免任一通路把 URL 当 base64 透传到渲染端造成破图。
 */
export const sanitizeImageBase64Payload = (value: unknown): string => {
    if (typeof value !== "string") return "";
    const trimmed = value.trim();
    if (!trimmed) return "";
    // 显式 data URL：剥离 schema 头，仅保留 base64 主体
    if (/^data:image\//i.test(trimmed)) {
        const base64Part = trimmed.split(",")[1] || "";
        return sanitizeImageBase64Payload(base64Part);
    }
    // 任何 http(s):// / asset:// / blob: / file: 都不是 base64
    if (/^(https?:|asset:|blob:|file:)/i.test(trimmed)) return "";
    // base64 字符集校验（允许 URL-safe 与少量空白），随后兜底转成标准 base64
    if (!/^[A-Za-z0-9+/=\-_\s]+$/.test(trimmed)) return "";
    const cleaned = normalizeBase64Payload(trimmed);
    if (cleaned.length < 256) return ""; // 一张可见图至少应有几百字节 base64
    if (!/^[A-Za-z0-9+/=]+$/.test(cleaned)) return "";
    // 🔧 NEW: magic-byte 校验，过滤 HTML/JSON 错误体被当成 b64 的情况
    try {
        const buf = Buffer.from(cleaned, "base64");
        if (!isLikelyImageBuffer(buf)) return "";
    } catch {
        return "";
    }
    return cleaned;
};

/**
 * 服务端拉取远端图片 URL 并转换为 base64。
 *
 * gpt-image-2 / DALL·E / 各类 Azure Blob 签名 URL 等模型若仅返回 URL，
 * 渲染端往往因 CORS / URL 过期 / 跨域鉴权失败而显示破损缩略图。
 * 这里强制服务端落 buffer 转 base64，渲染端只接受真正的 base64 字符串。
 *
 * 失败时 throw —— 调用方必须把异常视为「该响应不可用」，禁止回退到原始 URL 字符串。
 *
 * 🔧 v2 改进（解决"连续生成多张破图"）：
 *   1. Content-Type 校验：响应头不是 image/* 直接判失败（拦 HTML 错误页）；
 *   2. magic-byte 校验：buffer 头不是已知图像格式直接判失败（拦零字节 / 错误体）；
 *   3. 超时 30s → 60s：连续生成 PPT 时 OpenAI Blob 在限流下会变慢；
 *   4. 1 次轻量重试：网络抖动 / 5xx 不至于直接砸成「当前页生成失败」。
 */
export const fetchRemoteImageAsBase64 = async (url: string, signal?: AbortSignal): Promise<string> => {
    const FETCH_TIMEOUT_MS = 60000;
    const MAX_ATTEMPTS = 2;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const effectiveSignal = signal || AbortSignal.timeout(FETCH_TIMEOUT_MS);
        try {
            const response = await queuedFetch(
                url,
                {
                    headers: { "User-Agent": "md2pptWin-image/1.0" },
                    signal: effectiveSignal,
                },
                "high"
            );
            if (!response.ok) {
                lastError = new Error(`Remote image URL responded with ${response.status}`);
                // 4xx 客户端错误不重试；5xx / 网络错误才重试
                if (response.status < 500) throw lastError;
                continue;
            }
            const contentType = (response.headers.get("content-type") || "").toLowerCase();
            if (contentType && !contentType.startsWith("image/")) {
                throw new Error(
                    `Remote image URL returned non-image content-type: ${contentType.slice(0, 60)}`
                );
            }
            const buffer = Buffer.from(await response.arrayBuffer());
            if (!buffer.length) {
                lastError = new Error("Remote image URL returned empty body");
                continue;
            }
            if (!isLikelyImageBuffer(buffer)) {
                // 不是合法图像（可能是 HTML/JSON 错误页），尝试下一次但不再退避太多
                lastError = new Error("Remote image URL returned non-image bytes");
                continue;
            }
            const base64 = buffer.toString("base64");
            if (base64.length < 256) {
                lastError = new Error("Remote image URL returned suspiciously short payload");
                continue;
            }
            return base64;
        } catch (error) {
            lastError = error;
            // AbortError / 网络错误 → 下一轮；其他错误（如 4xx throw）让上面的 if 短路掉
            if (error instanceof Error && /^Remote image URL responded with 4/.test(error.message)) {
                throw error;
            }
        }
    }
    throw lastError instanceof Error
        ? lastError
        : new Error("Remote image URL fetch failed after retries");
};

/**
 * 把上游 image 对象（可能含 b64_json / url / 二者皆有）转换为可信赖的 base64。
 *
 * 顺序：
 *   1. 先校验 b64_json —— 通过 sanitize 过滤截断 / URL 误入 / HTML 错误页等坏数据；
 *   2. 校验失败但 url 是 data URL —— 拆 base64 主体；
 *   3. url 是 http(s):// —— 服务端下载并转 base64；
 *   4. 全部失败 —— throw，调用方必须当成失败处理（不能把 URL 当 imageBase64 透传）。
 *
 * 历史 BUG：原代码 `const imageBase64 = image.b64_json || image.url;` 在 b64_json 损坏 /
 * URL 抓取失败时会把 URL 字符串塞进 imageBase64 字段，渲染端接到 "https://..."
 * 当作 base64 拼 data URL → 破损缩略图。
 */
export const resolveImageToBase64 = async (
    image: { b64_json?: string; url?: string } | null | undefined,
    signal?: AbortSignal
): Promise<string> => {
    if (!image) {
        throw new Error("No image data in response");
    }
    const sanitized = sanitizeImageBase64Payload(image.b64_json);
    if (sanitized) return sanitized;

    const directUrl = typeof image.url === "string" ? image.url.trim() : "";
    if (!directUrl) {
        throw new Error("Image response had no usable b64_json or url");
    }

    if (/^data:image\//i.test(directUrl)) {
        const fromDataUrl = sanitizeImageBase64Payload(directUrl);
        if (fromDataUrl) return fromDataUrl;
        throw new Error("Image response data URL was not valid base64");
    }

    if (/^https?:\/\//i.test(directUrl)) {
        const fetched = await fetchRemoteImageAsBase64(directUrl, signal);
        return fetched;
    }

    throw new Error(`Image response url scheme not supported: ${directUrl.slice(0, 40)}`);
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
            // 🔧 FIX: 统一走 sanitizeImageBase64Payload（含 magic-byte + 长度校验），
            // 避免 OpenAI 限流期返回的截断 / HTML 错误体被认作合法 base64 → 破损缩略图。
            const sanitized = sanitizeImageBase64Payload(val);
            if (sanitized) {
                console.log("[SharedUtils] Found valid base64 data, length:", sanitized.length);
                return sanitized;
            }

            const trimmed = val.trim();
            // Check for data URL format (sanitize 已经覆盖，这里保留作为日志入口，避免改动太多)
            if (trimmed.startsWith('data:image/')) {
                const fromDataUrl = sanitizeImageBase64Payload(trimmed);
                if (fromDataUrl) {
                    console.log("[SharedUtils] Found data URL, extracting base64");
                    return fromDataUrl;
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
                return normalizeBase64Payload(base64Part);
            }
            continue;
        }

        if (url.startsWith("http")) {
            try {
                console.log("[SharedUtils] Fetching image from URL:", url);
                // 🔧 FIX: 复用统一的 fetchRemoteImageAsBase64（含 Content-Type + magic-byte
                // 校验 + 60s 超时 + 1 次重试），避免 OpenAI 限流时返回 HTML 错误页被当成 b64。
                const base64 = await fetchRemoteImageAsBase64(url);
                console.log("[SharedUtils] Converted URL to base64, length:", base64.length);
                return base64;
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

// ==================== 🔧 MERGE (2026-07-03 镜像合并): 云端独有的 coerce 系 API ====================
// image 路由与 api-proxy-layer 依赖 coerceImageValueToBase64（markdown/data URL/http 统一转 base64，
// 含 magic-byte 校验与 queuedFetch 低优先级下载）。与桌面系 resolveImageToBase64 并存，勿混用。
export const isValidImageBase64 = (base64: string): boolean => {
    if (!base64 || typeof base64 !== "string") return false;
    const cleaned = base64.replace(/[\s\n\r]/g, "");
    if (cleaned.length < 256) return false;
    if (!/^[A-Za-z0-9+/=]+$/.test(cleaned)) return false;
    try {
        // 只解前 64 字节就够判头（节省内存）
        const head = Buffer.from(cleaned.slice(0, 88), "base64");
        return isLikelyImageBuffer(head);
    } catch {
        return false;
    }
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
 * v3 改进（2026-05 第 6 次修复）：
 *   - URL fetch 后校验 Content-Type，非 image/* 直接判失败；
 *   - 返回前对 base64 做 magic-byte 校验，过滤 HTML/JSON 错误体；
 *   - 失败路径打印诊断（URL / status / content-type / head bytes），便于排障。
 *
 * 入参可能形态：
 *   - 纯 base64：magic-byte 通过则返回（去除空白），不通过返回 ""
 *   - data:image/...;base64,xxx：抽取 base64 部分后做 magic-byte 校验
 *   - https://... 或 http://...：fetch + Content-Type + magic-byte 三重校验
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
        if (comma < 0) return "";
        const b64 = extracted.slice(comma + 1).replace(/[\s\n\r]/g, "");
        if (!isValidImageBase64(b64)) {
            console.warn(
                `[coerceImageValueToBase64] data URL base64 magic-byte 校验失败 head=${b64.slice(0, 64)}`
            );
            return "";
        }
        return b64;
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
                    `[coerceImageValueToBase64] fetch ${extracted.substring(0, 120)} -> HTTP ${res.status}`
                );
                return "";
            }
            const ct = (res.headers.get("content-type") || "").toLowerCase();
            const ctOk =
                !ct ||
                ct.startsWith("image/") ||
                ct.startsWith("application/octet-stream") ||
                ct.startsWith("binary/");
            if (!ctOk) {
                console.warn(
                    `[coerceImageValueToBase64] non-image content-type=${ct} url=${extracted.substring(0, 120)}`
                );
                return "";
            }
            const buf = Buffer.from(await res.arrayBuffer());
            if (!isLikelyImageBuffer(buf)) {
                const headHex = buf.subarray(0, Math.min(16, buf.length)).toString("hex");
                console.warn(
                    `[coerceImageValueToBase64] magic-byte 校验失败 url=${extracted.substring(0, 120)} ct=${ct} bytes=${buf.length} head=${headHex}`
                );
                return "";
            }
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

    // 其他都按已经是纯 base64 字符串处理 —— 必须 magic-byte 校验通过才算数
    const b64 = extracted.replace(/[\s\n\r]/g, "");
    if (!isValidImageBase64(b64)) {
        console.warn(
            `[coerceImageValueToBase64] 上游 b64_json 字段 magic-byte 校验失败 len=${b64.length} head=${b64.slice(0, 64)}`
        );
        return "";
    }
    return b64;
};
