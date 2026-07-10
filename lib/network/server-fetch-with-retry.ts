import {
  createInternalTimeoutSignal,
  isInternalTimeoutAbort,
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
  /** Optional security/observability boundary invoked for every physical attempt. */
  request?: (input: string, init: RequestInit) => Promise<Response>;
};

// 注：520-527、530 这类 Cloudflare 网关错误**不**加入默认重试集合（与 fetch-with-retry.ts 同步）。
//   原因：Cloudflare 524 默认 100 秒才返回，重试 3 次会让客户端卡 5 分钟。出现 524 时直接快速
//   失败，由调用方按业务路径决定 fallback。
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
    const defaultSession = electron.session?.defaultSession;
    const sessionFetch = defaultSession?.fetch;
    if (typeof sessionFetch === "function") {
      return sessionFetch.bind(defaultSession);
    }
    const netFetch = electron.net?.fetch;
    if (typeof netFetch === "function") {
      return netFetch.bind(electron.net);
    }
  } catch (electronRequireErr) {
    // 🔧 FIX (2026-05-24)：以前是默默吞掉，导致用户看到 "All connection attempts failed"
    // 时无法分辨"走 Electron net 但失败"还是"根本没走 Electron net 退回 undici"。
    // 现在打 warn 让 main process console 留痕，配合下方 fetch 选择 log 一起诊断。
    console.warn(
      "[server-fetch] failed to acquire electron.net.fetch, falling back to global undici fetch:",
      electronRequireErr instanceof Error
        ? electronRequireErr.message
        : String(electronRequireErr)
    );
  }
  return null;
};

// 🔧 FIX (2026-05-24)：构造一个 IPv4-only 的 undici Dispatcher 作为最后兜底。
// 仅在 Node 内置 fetch (undici) 路径上启用；Electron net.fetch 自带 happy-eyeballs 不需要。
// 真实根因（IPv6 优先 + 上游 IPv6 不通 → "All connection attempts failed"）由
// main.cjs 的 dns.setDefaultResultOrder('ipv4first') 在主进程层面解决；此处的 IPv4-only
// dispatcher 只是双保险，万一 dns 设置被外部工具/环境覆盖也能扛住。
//
// 不在模块加载时构造（避免对 undici 的硬依赖在非 Node 环境炸开），改成 lazy。
let cachedIpv4Dispatcher: unknown = null;
let ipv4DispatcherUnavailable = false;
const getIpv4Dispatcher = (): unknown => {
  if (cachedIpv4Dispatcher) return cachedIpv4Dispatcher;
  if (ipv4DispatcherUnavailable) return null;
  try {
    const dynamicRequire = Function("return require")() as NodeRequire;
    const undici = dynamicRequire("undici") as {
      Agent?: new (opts: Record<string, unknown>) => unknown;
    };
    if (typeof undici?.Agent !== "function") {
      ipv4DispatcherUnavailable = true;
      return null;
    }
    cachedIpv4Dispatcher = new undici.Agent({
      connect: {
        // 4 = AF_INET（IPv4-only）。这是 net.connect 的 family 参数。
        family: 4,
        timeout: 30_000,
      },
    });
    return cachedIpv4Dispatcher;
  } catch {
    ipv4DispatcherUnavailable = true;
    return null;
  }
};

const wrapGlobalFetchWithIpv4 = (impl: typeof fetch): typeof fetch => {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const dispatcher = getIpv4Dispatcher();
    if (!dispatcher) return impl(input, init);
    // undici 的 fetch init 接受非标准 dispatcher 字段，但 TS Web fetch 类型不知道。
    const initWithDispatcher = { ...(init || {}), dispatcher } as Parameters<typeof fetch>[1];
    return impl(input, initWithDispatcher);
  }) as typeof fetch;
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
  const globalFetch = globalThis.fetch.bind(globalThis);
  candidates.push({
    name: "global-ipv4-first",
    fetchImpl: wrapGlobalFetchWithIpv4(globalFetch),
  });
  return candidates;
};

const normalizeServerFetchError = (error: unknown, timeoutMs?: number) => {
  // 🔧 FIX (2026-06-11 BUG-C14): 只有内部超时（md2ppt-timeout 标记）才翻译成
  // "Request timeout after Xms"；外部用户 abort 原样保留（其消息不含 timeout，
  // 在 isRetryableNetworkError 新正则下不可重试，会被直接抛出）。旧实现把所有
  // aborted/AbortError 一律当超时，导致用户取消被当成可重试错误继续打上游。
  if (
    typeof timeoutMs === "number" &&
    timeoutMs > 0 &&
    isInternalTimeoutAbort(error)
  ) {
    return new Error(`Request timeout after ${timeoutMs}ms`);
  }
  if (error instanceof Error) {
    return error;
  }
  const message = String(error || "").trim();
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

  const fetchCandidates = options.request
    ? [{ name: "custom-request", fetchImpl: options.request as typeof fetch }]
    : getServerFetchCandidates();
  let lastError: unknown = null;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    // 🔧 FIX (2026-06-11 BUG-C14): 每轮重试前检查外部 signal——用户已取消时立即抛
    // AbortError，不再发起新一轮请求/候选切换。
    if (init.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    // 🔧 FIX (2026-06-11 BUG-C3/A8): candidate 循环只负责"传输层异常"的实现切换
    // （fetch throw 才换下一个 candidate）。一旦收到任何 HTTP 响应（含 429/5xx 等
    // 可重试状态码）立即跳出 candidate 循环；可重试状态码的重发只由外层 attempt
    // 循环带退避执行。旧实现在同一个 attempt 内对每个 candidate 都重发一遍可重试
    // 状态码请求（3 个 candidate × 3 attempts = 同一请求最多打 9 次，且无退避），
    // 是重试风暴的核心放大器之一。
    let attemptResponse: Response | null = null;

    for (const candidate of fetchCandidates) {
      if (init.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      let cancelInternalTimeout: (() => void) | null = null;
      try {
        let signal = init.signal || undefined;
        if (typeof timeoutMs === "number" && timeoutMs > 0) {
          // 🔧 FIX (2026-06-11 BUG-C14): 内部超时带 md2ppt-timeout 标记，
          // 与外部用户 abort 可区分。
          // 🔧 FIX (2026-06-11 A17×C15 耦合): 外部信号存在时与内部超时合并——
          // 旧实现 init.signal 存在即跳过内部超时，summary 透传 req.signal 后
          // 挂死连接将永不超时。Node≥20.3 的 AbortSignal.any 合并二者。
          const internalTimeout = createInternalTimeoutSignal(timeoutMs);
          cancelInternalTimeout = internalTimeout.cancel;
          signal =
            signal && typeof AbortSignal.any === "function"
              ? AbortSignal.any([signal, internalTimeout.signal])
              : signal || internalTimeout.signal;
        }
        attemptResponse = await candidate.fetchImpl(input, {
          ...init,
          signal,
        });
        break;
      } catch (error) {
        const normalizedError = normalizeServerFetchError(error, timeoutMs);
        lastError = normalizedError;
        // 🔧 FIX (2026-05-24)：诊断 log。以前所有 fetch 失败都被静默吞掉，用户只看到上层
        // 的 "All connection attempts failed"，无法分辨：① undici IPv6/IPv4 全失败
        // ② Electron net.fetch 不可用退回 undici ③ 上游 host 真的全死。
        // 现在把 "candidate.name + 目标 URL host + 错误信息" 打到主进程 stderr，
        // Electron 主进程 console 直接可见，DevTools 里也能查。
        const isLastCandidate =
          candidate === fetchCandidates[fetchCandidates.length - 1];
        const isLastAttempt = attempt === retries - 1;
        const detail = normalizedError instanceof Error ? normalizedError.message : String(normalizedError);
        let targetHost = "";
        try {
          targetHost = new URL(input).host;
        } catch {
          targetHost = String(input).slice(0, 80);
        }
        // 仅在"完全失败"时打 warn（避免 retry 间噪音）；中间失败打 debug 级别。
        if (isLastCandidate && isLastAttempt) {
          console.warn(
            `[server-fetch] all candidates failed for ${targetHost} after ${retries} attempts. Last error from "${candidate.name}": ${detail}`
          );
        } else {
          console.debug(
            `[server-fetch] candidate "${candidate.name}" failed for ${targetHost} (attempt ${attempt + 1}/${retries}): ${detail}`
          );
        }
        if (!retryOnError(normalizedError)) {
          throw normalizedError;
        }
      } finally {
        cancelInternalTimeout?.();
      }
    }

    if (attemptResponse) {
      const shouldRetryResponse = retryOnResponse
        ? retryOnResponse(attemptResponse)
        : retryOnStatuses.includes(attemptResponse.status);

      if (!shouldRetryResponse) {
        return attemptResponse;
      }
      if (attempt >= retries - 1) {
        // 最后一轮：把可重试状态码响应原样返回给调用方（保持旧语义）。
        return attemptResponse;
      }
      // 🔧 FIX (2026-06-11 BUG-C19): 被重试丢弃的 Response 必须取消 body，
      // 释放底层连接/流，避免重试期间资源被挂起的响应占满。
      void attemptResponse.body?.cancel().catch(() => {});
      await sleep(retryDelayMs * (attempt + 1));
      continue;
    }

    // 所有 candidate 均传输层失败：退避后进入下一轮 attempt。
    if (attempt < retries - 1) {
      await sleep(retryDelayMs * (attempt + 1));
      continue;
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
