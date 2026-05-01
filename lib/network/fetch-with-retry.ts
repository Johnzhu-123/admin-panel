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

const DEFAULT_RETRYABLE_STATUSES = [408, 409, 425, 429, 500, 502, 503, 504];

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const isRetryableStatus = (status: number) =>
  DEFAULT_RETRYABLE_STATUSES.includes(status);

export const isRetryableNetworkError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error || "");
  return /fetch failed|Failed to fetch|ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_CONNECTION_REFUSED|ERR_TIMED_OUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network|timeout|ConnectTimeoutError|AbortError|sending request|aborted/i.test(
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
    try {
      const signal =
        init.signal ||
        (typeof timeoutMs === "number" && timeoutMs > 0
          ? AbortSignal.timeout(timeoutMs)
          : undefined);
      const response = await fetch(input, {
        ...init,
        signal,
      });

      const shouldRetryResponse = retryOnResponse
        ? retryOnResponse(response)
        : retryOnStatuses.includes(response.status);

      if (shouldRetryResponse && attempt < retries - 1) {
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }

      return response;
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
