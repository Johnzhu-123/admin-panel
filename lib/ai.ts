export type ApiProvider = "gemini" | "gemini_compat" | "openai";
export type OpenAiAuthHeader = "all" | "authorization" | "x-api-key" | "api-key";

export type InlineImage = {
  data: string;
  mimeType: string;
};

export const defaultOpenAiBaseUrl = "https://api.openai.com/v1";
export const defaultOpenAiTextModel = "gpt-4o-mini";
export const defaultOpenAiImageModel = "gpt-image-1";
export const defaultOpenAiVisionModel = "gpt-4o-mini";
export const defaultOpenAiAuthHeader: OpenAiAuthHeader = "all";
export const defaultOpenAiImageEndpointPath = "/images/generations";
export const defaultOpenAiImageResponseFormat = "auto";
export const defaultGeminiTextModel = "gemini-3-pro";
export const defaultGeminiImageModel = "gemini-3-pro-preview";
export const defaultGeminiBaseUrl = "https://generativelanguage.googleapis.com";
export const defaultGeminiApiVersion = "v1beta";

export const normalizeOpenAiBaseUrl = (raw?: string) => {
  const base = (raw || defaultOpenAiBaseUrl).trim();
  const trimmed = base.replace(/\/+$/, "");

  // 检查是否已经包含 /v1 路径
  const v1Match = trimmed.match(/\/v1(?:beta|alpha)?(?:\/|$)/i);
  if (v1Match && v1Match.index !== undefined) {
    const end = v1Match.index + v1Match[0].length;
    const sliceEnd = v1Match[0].endsWith("/") ? end - 1 : end;
    // 🔧 FIX (2026-06-11 BUG-CS2): /v1 为非末段（如 https://relay.example/v1/openai）
    // 时保留完整路径——旧实现会把 /v1 之后的真实网关前缀截掉，导致请求打错端点。
    // v1/v1beta/v1alpha 为末段时维持现有行为（去掉末尾斜杠后原样返回）。
    if (sliceEnd < trimmed.length) {
      return trimmed;
    }
    return trimmed.slice(0, sliceEnd);
  }

  // 检查是否有错误的重复路径模式（如 /v/v1, /V/v1, /V1）
  const duplicateMatch = trimmed.match(/\/(v|V)\/v1|\/V1/i);
  if (duplicateMatch) {
    // 移除错误的重复路径，只保留正确的 /v1
    const cleanBase = trimmed.replace(/\/(v|V)\/v1|\/V1/i, '');
    return `${cleanBase}/v1`;
  }

  return `${trimmed}/v1`;
};

export const buildOpenAiHeaders = (
  apiKey: string,
  json = false,
  authHeader: OpenAiAuthHeader = "all"
) => {
  const headers: Record<string, string> = {};
  if (authHeader === "all" || authHeader === "authorization") {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  if (authHeader === "all" || authHeader === "x-api-key") {
    headers["X-API-Key"] = apiKey;
  }
  if (authHeader === "all" || authHeader === "api-key") {
    headers["api-key"] = apiKey;
  }
  if (json) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
};

export const normalizeOpenAiAuthHeader = (raw?: string): OpenAiAuthHeader => {
  if (raw === "authorization" || raw === "x-api-key" || raw === "api-key" || raw === "all") {
    return raw;
  }
  return defaultOpenAiAuthHeader;
};

export const resolveOpenAiEndpoint = (baseUrl: string, path: string) => {
  const trimmed = (path || "").trim();
  if (!trimmed) return baseUrl;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  // Special handling for ModelGate API
  if (baseUrl.includes('mg.aid.pub')) {
    // For ModelGate, images use a different base URL structure
    if (trimmed.includes('/images/')) {
      // Use the API v1 path for images
      const imageBase = 'https://mg.aid.pub/api/v1';
      const cleanPath = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
      return `${imageBase}${cleanPath}`;
    }
    // For other endpoints, use the standard v1 path
    const normalizedBase = baseUrl.replace(/\/+$/, "");
    const cleaned = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    return `${normalizedBase}${cleaned}`;
  }

  // Standard OpenAI endpoint resolution
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const cleaned = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (/^\/v1/i.test(cleaned)) {
    const root = normalizedBase.replace(/\/v1(?:beta|alpha)?$/i, "");
    return `${root}${cleaned}`;
  }
  return `${normalizedBase}${cleaned}`;
};

export const normalizeGeminiBaseUrl = (raw?: string) => {
  const base = (raw || defaultGeminiBaseUrl).trim();
  const trimmed = base.replace(/\/+$/, "");
  const match = trimmed.match(/\/(v1[a-z]*)$/i);
  if (match) {
    return {
      baseUrl: trimmed.slice(0, -match[0].length),
      apiVersion: match[1],
    };
  }
  return {
    baseUrl: trimmed,
    apiVersion: defaultGeminiApiVersion,
  };
};

export const looksLikeGeminiModel = (raw?: string) => {
  const model = (raw || "").trim();
  return /^gemini(?:[-_]|$)/i.test(model);
};

export const parseJsonFromText = (text: string) => {
  const trimmed = (text || "").trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    // 🔧 FIX (2026-06-11 BUG-A1): 原正则把 \s 写成 \\s（regex 字面量双重转义），
    // ```json 围栏提取分支 100% 失效；且顶层数组无兜底。现修复围栏匹配并补数组提取。
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch {
        // Fall through to substring parsing.
      }
    }
    const tryParseSlice = (open: string, close: string) => {
      const start = trimmed.indexOf(open);
      const end = trimmed.lastIndexOf(close);
      if (start !== -1 && end !== -1 && end > start) {
        try {
          return JSON.parse(trimmed.slice(start, end + 1));
        } catch {
          return undefined;
        }
      }
      return undefined;
    };
    const objectResult = tryParseSlice("{", "}");
    if (objectResult !== undefined) return objectResult;
    const arrayResult = tryParseSlice("[", "]");
    if (arrayResult !== undefined) return arrayResult;
    return {};
  }
};

export const stringifyJsonAsciiSafe = (value: unknown) =>
  JSON.stringify(value).replace(/[\u0080-\uFFFF]/g, (char) => {
    const hex = char.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${hex}`;
  });

export const normalizeJsonRequestBodyToAsciiSafe = (
  rawBodyText?: string,
  fallbackValue?: unknown
) => {
  const trimmed = typeof rawBodyText === "string" ? rawBodyText.trim() : "";
  if (trimmed) {
    try {
      return stringifyJsonAsciiSafe(JSON.parse(trimmed));
    } catch {
      return rawBodyText;
    }
  }
  if (fallbackValue === undefined) {
    return rawBodyText;
  }
  return stringifyJsonAsciiSafe(fallbackValue);
};

export const isAsciiCodecError = (message?: string) => {
  const normalized = (message || "").trim();
  if (!normalized) return false;
  return (
    /'?ascii'?\s+codec/i.test(normalized) ||
    /ordinal\s+not\s+in\s+range\s*\(\s*128\s*\)/i.test(normalized) ||
    /cannot\s+encode/i.test(normalized) ||
    /can't\s+encode/i.test(normalized)
  );
};

export const containsNonAsciiText = (value?: string) =>
  typeof value === "string" && /[^\u0000-\u007f]/.test(value);

export const escapeStringToAsciiLiterals = (value: string) =>
  Array.from(value || "")
    .map((char) => {
      const codePoint = char.codePointAt(0);
      if (typeof codePoint !== "number" || codePoint <= 0x7f) {
        return char;
      }
      if (codePoint <= 0xffff) {
        return `\\u${codePoint.toString(16).padStart(4, "0")}`;
      }
      const offset = codePoint - 0x10000;
      const high = 0xd800 + (offset >> 10);
      const low = 0xdc00 + (offset & 0x3ff);
      return `\\u${high.toString(16).padStart(4, "0")}\\u${low
        .toString(16)
        .padStart(4, "0")}`;
    })
    .join("");

export const convertJsonStringsToAsciiLiterals = (value: unknown): unknown => {
  if (typeof value === "string") {
    return containsNonAsciiText(value) ? escapeStringToAsciiLiterals(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => convertJsonStringsToAsciiLiterals(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        convertJsonStringsToAsciiLiterals(item),
      ])
    );
  }
  return value;
};

export const formatAsciiCodecCompatMessage = (message?: string) => {
  const normalized = (message || "").trim();
  if (!isAsciiCodecError(normalized)) {
    return normalized;
  }
  if (normalized.startsWith("当前中转服务在转发请求时出现编码错误（")) {
    return normalized;
  }
  if (
    /(openai\s*兼容请求失败|gemini\s*(?:rest\s*)?(?:回退|兼容接口失败)|素材分析未返回可用文本|已尝试模型)/i.test(
      normalized
    )
  ) {
    return normalized;
  }
  const detail = normalized.length > 360 ? `${normalized.slice(0, 360)}...` : normalized;
  return `当前中转服务在转发请求时出现编码错误（${detail}）。这通常是兼容服务自身未正确处理 UTF-8 / 中文请求。应用已改为 ASCII 安全编码发送；若仍失败，请修复中转站编码链路，或切换到支持 UTF-8 的服务 / Gemini 原生直连。`;
};

export const pickOpenAiImageSize = (aspectRatio?: string) => {
  switch (aspectRatio) {
    case "16:9":
      return "1792x1024";
    case "3:4":
      return "1024x1536";
    case "9:16":
      return "1024x1792";
    default:
      return "1024x1024";
  }
};

export const noStoreHeaders = () => ({
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
});
