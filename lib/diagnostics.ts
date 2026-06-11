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
const failureLogs: FailureLogEntry[] = [];

const truncate = (value: string, limit = BODY_LIMIT) => {
  if (!value) return "";
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n...[truncated]`;
};

// 🔧 FIX (2026-06-11 BUG-C9): 失败日志里的 URL 可能携带 ?key=<apiKey>（Gemini 风格）
// 等敏感 query 参数，入库前必须打码。参数名按"全等"判断（精确分词），
// 避免误杀 monkey / keyboard 这类包含 "key" 的普通单词。
const SENSITIVE_KEY_NAMES = new Set([
  "key",
  "api-key",
  "apikey",
  "api_key",
  "token",
  "access_token",
  "access-token",
  "auth",
  "authorization",
  "password",
  "secret",
  "api-secret",
  "api_secret",
]);

export const looksSensitiveKey = (name: string): boolean => {
  const normalized = (name || "").trim().toLowerCase();
  if (!normalized) return false;
  return SENSITIVE_KEY_NAMES.has(normalized);
};

const REDACTED = "***";

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
    // 非标准 URL：退化为按 query 串打码（参数名仍按全词匹配）
    return rawUrl.replace(
      /([?&])(key|api[-_]?key|apikey|token|access[-_]?token|auth|authorization|password|secret|api[-_]?secret)=([^&#]*)/gi,
      `$1$2=${REDACTED}`
    );
  }
};

const formatBody = (body: unknown) => {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return truncate(body);
  try {
    return truncate(JSON.stringify(body, null, 2));
  } catch {
    return truncate(String(body));
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
    // 🔧 FIX (2026-06-11 BUG-C9): URL 入库前打码敏感 query 参数（?key= 等）
    url: sanitizeUrlForLog(entry.url),
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
