import {
  isRetryableNetworkError,
  readErrorMessage,
  sleep,
} from "@/lib/network/fetch-with-retry";

export type ServerFetchWithRetryOptions = {
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  retryOnStatuses?: number[];
  retryOnError?: (error: unknown) => boolean;
  retryOnResponse?: (response: Response) => boolean;
};

const DEFAULT_RETRYABLE_STATUSES = [408, 409, 425, 429, 500, 502, 503, 504];
type ServerFetchCandidate = {
  name: string;
  fetchImpl: typeof fetch;
};

const isElectronMainRuntime = () =>
  typeof window === "undefined" && typeof process !== "undefined" && !!process.versions?.electron;

const getElectronBridgeFetch = (): typeof fetch | null => {
  const bridge = (
    globalThis as typeof globalThis & {
      __MD2PPT_ELECTRON_FETCH__?: typeof fetch;
    }
  ).__MD2PPT_ELECTRON_FETCH__;
  return typeof bridge === "function" ? bridge : null;
};

const getElectronFetch = (): typeof fetch | null => {
  if (!isElectronMainRuntime()) return null;
  try {
    const dynamicRequire = Function("return require")() as NodeRequire;
    const electron = dynamicRequire("electron") as {
      net?: { fetch?: typeof fetch };
      session?: { defaultSession?: { fetch?: typeof fetch } };
    };
    const sessionFetch = electron.session?.defaultSession?.fetch;
    if (typeof sessionFetch === "function") {
      return sessionFetch.bind(electron.session.defaultSession);
    }
    const netFetch = electron.net?.fetch;
    if (typeof netFetch === "function") {
      return netFetch.bind(electron.net);
    }
  } catch {
    // Fall back to the standard Node fetch below.
  }
  return null;
};

const getServerFetchCandidates = (): ServerFetchCandidate[] => {
  const candidates: ServerFetchCandidate[] = [];
  const bridgeFetch = getElectronBridgeFetch();
  if (bridgeFetch) {
    candidates.push({ name: "electron-bridge", fetchImpl: bridgeFetch });
  }
  const electronFetch = bridgeFetch ? null : getElectronFetch();
  if (electronFetch) {
    candidates.push({ name: "electron-runtime", fetchImpl: electronFetch });
  }
  candidates.push({
    name: "global",
    fetchImpl: globalThis.fetch.bind(globalThis),
  });
  return candidates;
};

const normalizeServerFetchError = (error: unknown, timeoutMs?: number) => {
  if (error instanceof Error) {
    if (
      typeof timeoutMs === "number" &&
      timeoutMs > 0 &&
      (error.name === "AbortError" || /aborted|timeout/i.test(error.message))
    ) {
      return new Error(`Request timeout after ${timeoutMs}ms`);
    }
    return error;
  }
  const message = String(error || "").trim();
  if (typeof timeoutMs === "number" && timeoutMs > 0 && /aborted|timeout/i.test(message)) {
    return new Error(`Request timeout after ${timeoutMs}ms`);
  }
  return new Error(message || "Request failed.");
};

export async function serverFetchWithRetry(
  input: string,
  init: RequestInit = {},
  options: ServerFetchWithRetryOptions = {}
): Promise<Response> {
  const {
    retries = 3,
    retryDelayMs = 1500,
    timeoutMs,
    retryOnStatuses = DEFAULT_RETRYABLE_STATUSES,
    retryOnError = isRetryableNetworkError,
    retryOnResponse,
  } = options;

  const fetchCandidates = getServerFetchCandidates();
  let lastError: unknown = null;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    let lastRetryableResponse: Response | null = null;
    let shouldRetryAttempt = false;

    for (const candidate of fetchCandidates) {
      try {
        const signal =
          init.signal ||
          (typeof timeoutMs === "number" && timeoutMs > 0
            ? AbortSignal.timeout(timeoutMs)
            : undefined);
        const response = await candidate.fetchImpl(input, {
          ...init,
          signal,
        });

        const shouldRetryResponse = retryOnResponse
          ? retryOnResponse(response)
          : retryOnStatuses.includes(response.status);

        if (shouldRetryResponse) {
          lastRetryableResponse = response;
          shouldRetryAttempt = true;
          continue;
        }

        return response;
      } catch (error) {
        const normalizedError = normalizeServerFetchError(error, timeoutMs);
        lastError = normalizedError;
        if (!retryOnError(normalizedError)) {
          throw normalizedError;
        }
        shouldRetryAttempt = true;
      }
    }

    if (attempt < retries - 1 && shouldRetryAttempt) {
      await sleep(retryDelayMs * (attempt + 1));
      continue;
    }

    if (lastRetryableResponse) {
      return lastRetryableResponse;
    }
    if (lastError) {
      throw lastError;
    }
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error("请求失败");
}

export async function serverRequestTextWithRetry(
  input: string,
  init: RequestInit = {},
  options: ServerFetchWithRetryOptions = {}
) {
  const response = await serverFetchWithRetry(input, init, options);
  return {
    status: response.status,
    text: await response.text(),
  };
}

export { readErrorMessage as serverReadErrorMessage, isRetryableNetworkError };
