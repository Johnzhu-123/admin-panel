export type FetchWithRetryOptions = {
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  retryOnStatuses?: number[];
  retryOnError?: (error: unknown) => boolean;
  retryOnResponse?: (response: Response) => boolean;
};

export type RetryAsyncOptions = {
  retries?: number;
  retryDelayMs?: number;
  retryOnError?: (error: unknown) => boolean;
};

// 注：520-527、530 这类 Cloudflare 网关错误**不**加入默认重试集合。
//   原因：Cloudflare 524 默认 100 秒才返回，重试 3 次会让客户端卡 5 分钟，
//   远超用户可接受范围。出现 524 时直接快速失败，由调用方决定 fallback 策略。
const DEFAULT_RETRYABLE_STATUSES = [408, 409, 425, 429, 500, 502, 503, 504];

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const isRetryableStatus = (status: number) =>
  DEFAULT_RETRYABLE_STATUSES.includes(status);

// 🔧 FIX (2026-06-11 BUG-C14): 内部超时 abort 必须与"外部用户 abort"可区分。
// 内部超时统一用 abort(new Error(INTERNAL_TIMEOUT_REASON))，重试判定只认这个标记
// （以及真实网络层 timeout 错误码）；外部 AbortError 不再被 message 正则误判为可重试。
export const INTERNAL_TIMEOUT_REASON = "md2ppt-timeout";

const readErrorText = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error || "");
};

export const isInternalTimeoutAbort = (error: unknown) =>
  readErrorText(error).includes(INTERNAL_TIMEOUT_REASON);

/** 创建带 md2ppt-timeout 标记的内部超时 signal；调用方负责在请求结束后 cancel 计时器。 */
export const createInternalTimeoutSignal = (timeoutMs: number) => {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(INTERNAL_TIMEOUT_REASON)),
    timeoutMs
  );
  (timer as { unref?: () => void })?.unref?.();
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
};

export const isRetryableNetworkError = (error: unknown) => {
  const message = readErrorText(error);
  // 🔧 FIX (2026-06-11 BUG-C14): 从可重试正则中移除 AbortError|aborted ——
  // 外部用户取消（AbortError）必须直接抛出而不是重试；内部超时通过
  // md2ppt-timeout 标记识别（timeout 一词同时覆盖 ETIMEDOUT / Request timeout 等真实超时）。
  return /fetch failed|Failed to fetch|ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_CONNECTION_REFUSED|ERR_TIMED_OUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network|md2ppt-timeout|timeout|ConnectTimeoutError|sending request/i.test(
    message
  );
};

export async function readErrorMessage(
  response: Response,
  fallback = ""
): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return fallback;
  try {
    const data = JSON.parse(text);
    const message =
      data?.error?.message || data?.error || data?.message || data?.detail;
    return typeof message === "string" && message.trim() ? message.trim() : text;
  } catch {
    return text;
  }
}

export async function fetchWithRetry(
  input: string,
  init: RequestInit = {},
  options: FetchWithRetryOptions = {}
): Promise<Response> {
  const {
    retries = 3,
    retryDelayMs = 1500,
    timeoutMs,
    retryOnStatuses = DEFAULT_RETRYABLE_STATUSES,
    retryOnError = isRetryableNetworkError,
    retryOnResponse,
  } = options;

  let lastError: unknown = null;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    // 🔧 FIX (2026-06-11 BUG-C14): 每轮尝试前检查外部 signal——用户已取消时立即抛
    // AbortError，绝不再发起新一轮请求（旧实现会带着已 abort 的 signal 继续重试）。
    if (init.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    let cancelInternalTimeout: (() => void) | null = null;
    try {
      let signal = init.signal || undefined;
      if (!signal && typeof timeoutMs === "number" && timeoutMs > 0) {
        // 🔧 FIX (2026-06-11 BUG-C14): 内部超时不再用 AbortSignal.timeout（其错误
        // 与用户 abort 难以区分），改用带 md2ppt-timeout 标记的 controller。
        const internalTimeout = createInternalTimeoutSignal(timeoutMs);
        signal = internalTimeout.signal;
        cancelInternalTimeout = internalTimeout.cancel;
      }
      const response = await fetch(input, {
        ...init,
        signal,
      });

      const shouldRetryResponse = retryOnResponse
        ? retryOnResponse(response)
        : retryOnStatuses.includes(response.status);

      if (shouldRetryResponse && attempt < retries - 1) {
        // 🔧 FIX (2026-06-11 BUG-C19): 被重试丢弃的 Response 必须取消 body，
        // 否则连接/内存被挂起的流占住，放大重试风暴的资源消耗。
        void response.body?.cancel().catch(() => {});
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }

      return response;
    } catch (error) {
      // 🔧 FIX (2026-06-11 BUG-C14): 内部超时（md2ppt-timeout 标记）对外统一翻译成
      // 可读的 "Request timeout after Xms"，避免把内部标记串泄漏给调用方/UI。
      const normalizedError =
        isInternalTimeoutAbort(error) &&
        typeof timeoutMs === "number" &&
        timeoutMs > 0
          ? new Error(`Request timeout after ${timeoutMs}ms`)
          : error;
      lastError = normalizedError;
      // 🔧 FIX (2026-06-11 BUG-C14): 外部用户 abort 直接抛出（默认
      // isRetryableNetworkError 已不再匹配 AbortError/aborted）；内部超时
      // （md2ppt-timeout）与真实网络错误仍按可重试处理。
      if (init.signal?.aborted) {
        throw error;
      }
      if (attempt < retries - 1 && retryOnError(normalizedError)) {
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }
      throw normalizedError;
    } finally {
      cancelInternalTimeout?.();
    }
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error("请求失败");
}

export async function retryAsync<T>(
  task: () => Promise<T>,
  options: RetryAsyncOptions = {}
): Promise<T> {
  const {
    retries = 3,
    retryDelayMs = 1500,
    retryOnError = isRetryableNetworkError,
  } = options;

  let lastError: unknown = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt < retries - 1 && retryOnError(error)) {
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }
      throw error;
    }
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error("请求失败");
}
