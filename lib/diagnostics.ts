export type FailureLogEntry = {
  id: string;
  at: string;
  provider: string;
  operation: string;
  url: string;
  status: number | null;
  requestBody: string;
  responseBody: string;
};

const MAX_LOGS = 200;
const BODY_LIMIT = 4000;
const REDACTED = "[REDACTED]";
const failureLogs: FailureLogEntry[] = [];

const truncate = (value: string, limit = BODY_LIMIT) => {
  if (!value) return "";
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n...[truncated]`;
};

// 🔧 FIX (2026-06-11 BUG-C9，两仓合并版): 敏感参数名判定。
// - 精确等值匹配（归一化后），不做 includes("key")，避免误杀 monkey / keyboard
//   这类包含 "key" 的普通词。Gemini 原生 `?key=<apiKey>` 查询串此前不被识别，
//   完整 key 会进失败日志明文留存。
// - 归一化剔除 a-z0-9_ 以外字符：api-key → apikey、x-goog-api-key → xgoogapikey。
// - "auth" 精确项来自云端 BUG-C9 集合；token/secret/password/session/jwt 走包含匹配
//   （覆盖 access_token / api-secret / __session / __clerk_db_jwt 等变体）。
export const looksSensitiveKey = (rawKey: string): boolean => {
  const key = String(rawKey || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "");
  if (!key) return false;
  if (
    key === "key" ||
    key === "auth" ||
    key === "authorization" ||
    key === "apikey" ||
    key === "api_key" ||
    key === "xapikey" ||
    key === "x_api_key" ||
    key === "xgoogapikey" ||
    key === "x_goog_api_key"
  ) {
    return true;
  }
  if (key.includes("token") || key.includes("secret") || key.includes("password")) {
    return true;
  }
  if (key.includes("session") || key.includes("jwt")) {
    return true;
  }
  return false;
};

const redactQueryString = (text: string) =>
  text.replace(/([?&#])([^=&#\s]+)=([^&#\s]*)/g, (full, sep, key, value) => {
    if (!value) return full;
    return looksSensitiveKey(key) ? `${sep}${key}=${REDACTED}` : full;
  });

// 🔧 FIX (2026-06-11 BUG-C9，云端实现): 失败日志里的 URL 可能携带 ?key=<apiKey>
// （Gemini 风格）等敏感 query 参数，入库前必须打码。标准 URL 走 URL 解析逐参数
// 判定；非标准 URL 退化为按 query 串正则打码（参数名仍走 looksSensitiveKey 全词判定）。
export const sanitizeUrlForLog = (rawUrl: string): string => {
  if (!rawUrl) return "";
  try {
    const parsed = new URL(rawUrl);
    let changed = false;
    for (const name of Array.from(parsed.searchParams.keys())) {
      if (looksSensitiveKey(name)) {
        parsed.searchParams.set(name, REDACTED);
        changed = true;
      }
    }
    return changed ? parsed.toString() : rawUrl;
  } catch {
    return redactQueryString(rawUrl);
  }
};

const redactString = (rawText: string) => {
  let text = String(rawText || "");
  if (!text) return text;

  text = text.replace(
    /\b(?:https?|wss?|xinghuoppt):\/\/[^\s"']+/gi,
    (match) => redactQueryString(match)
  );
  text = redactQueryString(text);
  text = text.replace(
    /(authorization\s*[:=]\s*["']?bearer\s+)([a-z0-9\-._~+/]+=*)/gi,
    `$1${REDACTED}`
  );
  text = text.replace(
    /(["']?(?:authorization|api[_-]?key|x-api-key|token|session_token|__session|__clerk_db_jwt|refresh_token|id_token|secret|password|jwt)["']?\s*[:=]\s*["']?)([^"',\s}]+)/gi,
    `$1${REDACTED}`
  );

  return text;
};

const sanitizeForLog = (value: unknown, parentKey = "", seen = new WeakSet<object>()): unknown => {
  if (value === null || value === undefined) return value;
  if (looksSensitiveKey(parentKey)) return REDACTED;

  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "function") return "[Function]";

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message || ""),
      stack: redactString(value.stack || ""),
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item, "", seen));
  }

  if (typeof value === "object") {
    if (seen.has(value as object)) return "[Circular]";
    seen.add(value as object);
    const obj = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(obj)) {
      output[key] = sanitizeForLog(item, key, seen);
    }
    return output;
  }

  return redactString(String(value));
};

const formatBody = (body: unknown) => {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return truncate(redactString(body));
  try {
    return truncate(JSON.stringify(sanitizeForLog(body), null, 2));
  } catch {
    return truncate(redactString(String(body)));
  }
};

export const recordFailureLog = (entry: {
  provider: string;
  operation: string;
  url: string;
  status: number | null;
  requestBody?: unknown;
  responseBody?: unknown;
}) => {
  const log: FailureLogEntry = {
    id: `log-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    at: new Date().toISOString(),
    provider: entry.provider,
    operation: entry.operation,
    // 🔧 FIX (2026-06-11 BUG-C9，合并): 先走 URL 解析的逐参数打码（云端实现），
    // 再过 redactString 兜底（覆盖非 URL 形态与嵌入式凭证）。
    url: redactString(sanitizeUrlForLog(entry.url)),
    status: entry.status ?? null,
    requestBody: formatBody(entry.requestBody),
    responseBody: formatBody(entry.responseBody),
  };
  failureLogs.unshift(log);
  if (failureLogs.length > MAX_LOGS) {
    failureLogs.length = MAX_LOGS;
  }
};

export const listFailureLogs = () => [...failureLogs];

export const clearFailureLogs = () => {
  failureLogs.length = 0;
};
