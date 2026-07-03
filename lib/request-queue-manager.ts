/**
 * 请求队列管理器
 * 防止并发请求导致 429 错误和 IP 风控
 * 🔧 ENHANCED: 添加自适应速率限制和智能重试机制
 */

interface QueuedRequest {
  id: string;
  url: string;
  options: QueuedRequestInit;
  resolve: (value: Response) => void;
  reject: (reason: any) => void;
  timestamp: number;
  retryCount: number;
  rateLimitRetryCount: number;   // 🔧 FIX (2026-06-11 BUG-A19): 429 在本层的独立重试计数
  priority: 'high' | 'normal' | 'low';
  userId?: string;              // 用户ID，用于去重和统计
  requestHash?: string;         // 请求哈希，用于去重
}

/**
 * 🔧 FIX (2026-06-11 BUG-C5): 扩展 RequestInit，允许调用方传 timeoutMs 而不是
 * 预创建的 AbortSignal.timeout——超时计时改在请求"实际执行"时启动（排队不计时）。
 */
export type QueuedRequestInit = RequestInit & { timeoutMs?: number };

interface RateLimitConfig {
  maxConcurrent: number;        // 最大并发请求数
  requestsPerMinute: number;    // 每分钟最大请求数
  requestsPerSecond: number;    // 每秒最大请求数
  minInterval: number;          // 请求间最小间隔（毫秒）
  burstLimit: number;           // 突发请求限制
  adaptiveMode: boolean;        // 自适应速率限制模式
  maxRetries: number;           // 最大重试次数
  backoffMultiplier: number;    // 退避倍数
}

// 🔧 FIX (2026-06-11 BUG-A7): 非幂等请求（生成类 POST）禁用响应缓存与去重——
// 同 prompt 的两次图片/对话生成是两次独立计费操作，缓存/去重会让用户拿到旧图，
// 或让并发的两个不同业务请求错误共享同一个上游响应。
const NON_IDEMPOTENT_URL_PATTERNS = [
  "/api/ai/image",
  "/images/",
  "/chat/completions",
  "/api/ai/video",
  "/api/ai/tts",
];

const isNonIdempotentRequest = (url: string, options: RequestInit): boolean => {
  const method = (options.method || "GET").toUpperCase();
  if (method !== "POST") return false;
  const lowerUrl = (url || "").toLowerCase();
  return NON_IDEMPOTENT_URL_PATTERNS.some((pattern) => lowerUrl.includes(pattern));
};

const CACHE_TTL_MS = 60_000;            // 响应缓存 1 分钟
const CACHE_CLEANUP_INTERVAL_MS = 5 * 60_000; // 🔧 FIX (2026-06-11 BUG-C4): 定期清理过期缓存
const RATE_LIMIT_MAX_RETRIES = 2;        // 🔧 FIX (2026-06-11 BUG-A19): 429 本层最多重试 2 次

class RequestQueueManager {
  private queue: QueuedRequest[] = [];
  private activeRequests: Set<string> = new Set();
  private requestHistory: number[] = [];
  private lastRequestTime: number = 0;
  private config: RateLimitConfig;
  private isProcessing: boolean = false;

  // 🔧 NEW: 自适应速率限制相关
  private rateLimitErrors: number[] = [];      // 429错误时间戳
  private adaptiveMinInterval: number;         // 动态调整的最小间隔
  private requestCache = new Map<string, { response: Response; timestamp: number }>();  // 请求缓存
  private pendingRequests = new Map<string, Promise<Response>>();  // 进行中的请求（去重用）
  private cacheCleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = {
      maxConcurrent: 1,           // 🔧 REDUCED: 最多同时1个请求（避免429）
      requestsPerMinute: 15,      // 🔧 REDUCED: 每分钟最多15个请求
      requestsPerSecond: 1,       // 每秒最多1个请求
      minInterval: 2000,          // 🔧 INCREASED: 请求间隔至少2秒
      burstLimit: 2,              // 🔧 REDUCED: 突发最多2个请求
      adaptiveMode: true,         // 🔧 NEW: 启用自适应模式
      maxRetries: 5,              // 🔧 NEW: 最大重试5次
      backoffMultiplier: 2,       // 🔧 NEW: 指数退避倍数
      ...config
    };
    this.adaptiveMinInterval = this.config.minInterval;
    this.startCacheCleanup();
  }

  /**
   * 🔧 FIX (2026-06-11 BUG-C4): 缓存的 Response 之前只在"恰好命中同 hash"时才被
   * 惰性清掉，长进程里没人再发同样请求的过期条目永远滞留。这里加 5 分钟一次的
   * 定期清理，并 unref() 避免阻止进程退出。
   */
  private startCacheCleanup(): void {
    if (this.cacheCleanupTimer) return;
    if (typeof setInterval !== "function") return;
    this.cacheCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.requestCache) {
        if (now - entry.timestamp >= CACHE_TTL_MS) {
          this.requestCache.delete(key);
        }
      }
    }, CACHE_CLEANUP_INTERVAL_MS);
    (this.cacheCleanupTimer as unknown as { unref?: () => void })?.unref?.();
  }

  /**
   * 添加请求到队列
   * 🔧 ENHANCED: 添加请求去重和缓存检查
   */
  async enqueue(
    url: string,
    options: QueuedRequestInit = {},
    priority: 'high' | 'normal' | 'low' = 'normal',
    userId?: string
  ): Promise<Response> {
    // 🔧 FIX (2026-06-11 BUG-A7): 非幂等的生成类 POST 请求禁用缓存与去重，
    // 每次调用都必须真实打到上游。
    const nonIdempotent = isNonIdempotentRequest(url, options);

    // 🔧 NEW: 生成请求哈希用于去重
    const requestHash = nonIdempotent ? undefined : this.generateRequestHash(url, options);

    if (requestHash) {
      // 🔧 NEW: 检查缓存
      const cached = this.requestCache.get(requestHash);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        console.log(`✅ Cache hit for request: ${requestHash.substring(0, 8)}`);
        return cached.response.clone();
      }

      // 🔧 NEW: 检查是否有相同的请求正在进行（去重）
      const pending = this.pendingRequests.get(requestHash);
      if (pending) {
        console.log(`⏳ Deduplicating request: ${requestHash.substring(0, 8)}`);
        // 🔧 FIX (2026-06-11 BUG-C4): 去重命中返回 clone——旧实现把同一个 Response
        // 对象交给多个调用方，第一个读完 body 后其余调用方全部 "body used already"。
        return pending.then((response) => response.clone());
      }
    }

    // 创建新的请求Promise
    const requestPromise = new Promise<Response>((resolve, reject) => {
      const request: QueuedRequest = {
        id: this.generateRequestId(),
        url,
        options,
        resolve,
        reject,
        timestamp: Date.now(),
        retryCount: 0,
        rateLimitRetryCount: 0,
        priority,
        userId,
        requestHash
      };

      // 根据优先级插入队列
      if (priority === 'high') {
        this.queue.unshift(request);
      } else {
        this.queue.push(request);
      }

      console.log(`📥 Request queued: ${request.id} (${priority}) - Queue size: ${this.queue.length}`);

      // 开始处理队列
      this.processQueue();
    });

    if (requestHash) {
      // 记录进行中的请求
      this.pendingRequests.set(requestHash, requestPromise);

      // 请求完成后清理
      requestPromise.finally(() => {
        this.pendingRequests.delete(requestHash);
      }).catch(() => {
        // finally 衍生的 promise 链兜底，避免 unhandled rejection
      });

      // 🔧 FIX (2026-06-11 BUG-C4): 首个调用方也拿 clone——原始 Response 只作为
      // "克隆母本"保存在 pending promise 里。若把原始对象直接交给首个调用方，
      // 它一读 body 就锁流，后续去重命中的 clone() 全部抛 "body already used"。
      return requestPromise.then((response) => response.clone());
    }

    return requestPromise;
  }

  /**
   * 处理队列中的请求
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (this.queue.length > 0) {
        // 检查并发限制
        if (this.activeRequests.size >= this.config.maxConcurrent) {
          console.log(`Concurrent limit reached (${this.activeRequests.size}/${this.config.maxConcurrent}), waiting...`);
          await this.waitForSlot();
          continue;
        }

        // 检查速率限制
        if (!this.canMakeRequest()) {
          const waitTime = this.getWaitTime();
          console.log(`Rate limit reached, waiting ${waitTime}ms...`);
          await this.sleep(waitTime);
          continue;
        }

        // 获取下一个请求
        const request = this.queue.shift();
        if (!request) break;

        // 执行请求
        this.executeRequest(request);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * 执行单个请求
   * 🔧 ENHANCED: 添加429错误处理和自适应速率调整
   */
  private async executeRequest(request: QueuedRequest): Promise<void> {
    this.activeRequests.add(request.id);
    this.recordRequest();

    console.log(`🚀 Executing request: ${request.id} - Active: ${this.activeRequests.size}`);

    // 🔧 FIX (2026-06-11 BUG-C5): timeoutMs 在"实际执行"时才换成 AbortSignal，
    // 排队等待时间不计入超时。
    const { timeoutMs, ...fetchOptions } = request.options;
    let executionSignal: AbortSignal | undefined = fetchOptions.signal || undefined;
    if (
      !executionSignal &&
      typeof timeoutMs === "number" &&
      timeoutMs > 0 &&
      typeof AbortSignal !== "undefined" &&
      typeof AbortSignal.timeout === "function"
    ) {
      executionSignal = AbortSignal.timeout(timeoutMs);
    }

    try {
      const response = await fetch(request.url, {
        ...fetchOptions,
        ...(executionSignal ? { signal: executionSignal } : {}),
      });

      // 🔧 NEW: 检查429错误并自适应调整
      if (response.status === 429) {
        this.handle429Error(request, response);
        return;
      }

      // 🔧 NEW: 成功请求后逐渐恢复速率
      if (response.ok && this.config.adaptiveMode) {
        this.adjustRateLimitOnSuccess();
      }

      // 检查是否需要重试
      if (this.shouldRetry(response, request)) {
        // 🔧 FIX (2026-06-11 BUG-C19): 被重试丢弃的 Response 取消 body，释放连接
        void response.body?.cancel().catch(() => {});
        await this.retryRequest(request);
      } else {
        // 🔧 NEW: 缓存成功的响应（非幂等请求 requestHash 为空，天然不会被缓存）
        if (response.ok && request.requestHash) {
          this.requestCache.set(request.requestHash, {
            response: response.clone(),
            timestamp: Date.now()
          });
        }
        request.resolve(response);
      }
    } catch (error) {
      // 🔧 FIX (2026-06-11 BUG-C4): 用户已 abort 的请求不得重试——立即 reject，
      // 否则取消的图片生成会在后台继续重发并计费。
      if (request.options?.signal?.aborted || executionSignal?.aborted) {
        request.reject(error);
        return;
      }
      // 网络错误重试
      if (request.retryCount < this.config.maxRetries) {
        await this.retryRequest(request);
      } else {
        console.error(`❌ Request ${request.id} failed after ${request.retryCount} retries:`, error);
        request.reject(error);
      }
    } finally {
      this.activeRequests.delete(request.id);
    }
  }

  /**
   * 重试请求
   * 🔧 ENHANCED: 使用指数退避策略
   */
  private async retryRequest(request: QueuedRequest): Promise<void> {
    request.retryCount++;
    const delay = Math.min(
      this.config.minInterval * Math.pow(this.config.backoffMultiplier, request.retryCount),
      30000 // 最大30秒
    );

    console.log(`🔄 Retrying request ${request.id} (attempt ${request.retryCount}/${this.config.maxRetries}) after ${delay}ms`);

    setTimeout(() => {
      this.queue.unshift(request); // 重试请求放到队列前面
      this.processQueue();
    }, delay);
  }

  /**
   * 🔧 NEW: 处理429错误
   * 🔧 FIX (2026-06-11 BUG-A19): 429 只在本层做 ≤RATE_LIMIT_MAX_RETRIES 次退避重试，
   * 超限后 reject 并在错误信息里注明"已重试"，错误带上游 Retry-After（若有）——
   * 上层（fetchWithRetry / api-compatibility）看到该错误不应再叠加自己的 429 重试。
   */
  private handle429Error(request: QueuedRequest, response?: Response): void {
    const now = Date.now();
    this.rateLimitErrors.push(now);

    // 清理旧的错误记录（保留最近5分钟）
    this.rateLimitErrors = this.rateLimitErrors.filter(time => now - time < 300000);

    console.warn(`⚠️ 429 Rate Limit Error detected! Total in last 5min: ${this.rateLimitErrors.length}`);

    // 自适应调整速率限制
    if (this.config.adaptiveMode) {
      // 增加请求间隔
      this.adaptiveMinInterval = Math.min(
        this.adaptiveMinInterval * 1.5,
        10000 // 最大10秒
      );

      // 减少并发数
      if (this.config.maxConcurrent > 1) {
        this.config.maxConcurrent = Math.max(1, this.config.maxConcurrent - 1);
      }

      console.log(`🔧 Adaptive rate limit adjusted: minInterval=${this.adaptiveMinInterval}ms, maxConcurrent=${this.config.maxConcurrent}`);
    }

    // 读取上游 Retry-After（秒或 HTTP-date；只处理秒数形式）
    const retryAfterRaw = response?.headers?.get?.("retry-after") || "";
    const retryAfterSeconds = /^\d+$/.test(retryAfterRaw.trim())
      ? Number(retryAfterRaw.trim())
      : null;

    // 🔧 FIX (2026-06-11 BUG-C19): 丢弃的 429 响应取消 body
    void response?.body?.cancel().catch(() => {});

    if (request.rateLimitRetryCount < RATE_LIMIT_MAX_RETRIES) {
      request.rateLimitRetryCount++;
      const backoff = Math.min(
        this.config.minInterval *
          Math.pow(this.config.backoffMultiplier, request.rateLimitRetryCount),
        30000
      );
      const delay = retryAfterSeconds !== null
        ? Math.min(Math.max(retryAfterSeconds * 1000, backoff), 60000)
        : backoff;
      console.log(`🔄 429 retry ${request.rateLimitRetryCount}/${RATE_LIMIT_MAX_RETRIES} for ${request.id} after ${delay}ms`);
      setTimeout(() => {
        this.queue.unshift(request);
        this.processQueue();
      }, delay);
      return;
    }

    console.error(`❌ Request ${request.id} exceeded 429 retry budget (${RATE_LIMIT_MAX_RETRIES})`);
    const retryAfterNote = retryAfterSeconds !== null
      ? `；上游 Retry-After=${retryAfterSeconds}s`
      : "";
    const error = new Error(
      `Rate limit exceeded (HTTP 429)：队列层已重试 ${RATE_LIMIT_MAX_RETRIES} 次仍被限流，请稍后再试${retryAfterNote}。[已重试，请勿在上层叠加重试]`
    ) as Error & { status?: number; retryAfterSeconds?: number | null; alreadyRetried?: boolean };
    error.status = 429;
    error.retryAfterSeconds = retryAfterSeconds;
    error.alreadyRetried = true;
    request.reject(error);
  }

  /**
   * 🔧 NEW: 成功请求后逐渐恢复速率
   */
  private adjustRateLimitOnSuccess(): void {
    // 如果最近没有429错误，逐渐恢复速率
    const now = Date.now();
    const recentErrors = this.rateLimitErrors.filter(time => now - time < 60000);

    if (recentErrors.length === 0 && this.adaptiveMinInterval > this.config.minInterval) {
      // 逐渐减少间隔（恢复速率）
      this.adaptiveMinInterval = Math.max(
        this.config.minInterval,
        this.adaptiveMinInterval * 0.95
      );

      console.log(`✅ Rate limit recovering: minInterval=${this.adaptiveMinInterval}ms`);
    }
  }

  /**
   * 🔧 NEW: 生成请求哈希用于去重
   */
  private generateRequestHash(url: string, options: RequestInit): string {
    const body = options.body ? JSON.stringify(options.body) : '';
    const method = options.method || 'GET';
    return `${method}:${url}:${body}`;
  }

  /**
   * 检查是否应该重试
   * 🔧 ENHANCED: 改进重试逻辑
   */
  private shouldRetry(response: Response, request: QueuedRequest): boolean {
    if (request.retryCount >= this.config.maxRetries) return false;

    // 🔧 FIX (2026-06-11 BUG-A6): 服务端明确标记"不可重试"的响应（如 image route
    // 对"HTTP 200 但无图"返回的 502）直接放行给调用方，避免重试经济学灾难。
    if (response.headers?.get?.("x-md2ppt-no-retry") === "1") return false;

    // 429 (Too Many Requests) 应该重试（但由handle429Error处理）
    if (response.status === 429) return false; // 已在executeRequest中处理

    // 5xx 服务器错误应该重试
    if (response.status >= 500) return true;

    // 408 (Request Timeout) 应该重试
    if (response.status === 408) return true;

    return false;
  }

  /**
   * 检查是否可以发起请求
   * 🔧 ENHANCED: 使用自适应间隔
   */
  private canMakeRequest(): boolean {
    const now = Date.now();

    // 🔧 UPDATED: 使用自适应最小间隔
    const effectiveMinInterval = this.config.adaptiveMode ?
      this.adaptiveMinInterval : this.config.minInterval;

    if (now - this.lastRequestTime < effectiveMinInterval) {
      return false;
    }

    // 清理过期的请求历史
    this.cleanupHistory();

    // 检查每分钟限制
    const recentRequests = this.requestHistory.filter(time => now - time < 60000);
    if (recentRequests.length >= this.config.requestsPerMinute) {
      return false;
    }

    // 检查每秒限制
    const lastSecondRequests = this.requestHistory.filter(time => now - time < 1000);
    if (lastSecondRequests.length >= this.config.requestsPerSecond) {
      return false;
    }

    // 检查突发限制
    const burstRequests = this.requestHistory.filter(time => now - time < 5000);
    if (burstRequests.length >= this.config.burstLimit) {
      return false;
    }

    return true;
  }

  /**
   * 计算需要等待的时间
   * 🔧 ENHANCED: 使用自适应间隔
   */
  private getWaitTime(): number {
    const now = Date.now();

    // 🔧 UPDATED: 使用自适应最小间隔
    const effectiveMinInterval = this.config.adaptiveMode ?
      this.adaptiveMinInterval : this.config.minInterval;

    // 最小间隔等待时间
    const intervalWait = Math.max(0, effectiveMinInterval - (now - this.lastRequestTime));

    // 每秒限制等待时间
    const lastSecondRequests = this.requestHistory.filter(time => now - time < 1000);
    const secondWait = lastSecondRequests.length >= this.config.requestsPerSecond ?
      1000 - (now - Math.min(...lastSecondRequests)) : 0;

    return Math.max(intervalWait, secondWait, 500); // 至少等待500ms
  }

  /**
   * 记录请求时间
   */
  private recordRequest(): void {
    const now = Date.now();
    this.requestHistory.push(now);
    this.lastRequestTime = now;
  }

  /**
   * 清理过期的请求历史
   */
  private cleanupHistory(): void {
    const now = Date.now();
    this.requestHistory = this.requestHistory.filter(time => now - time < 60000);
  }

  /**
   * 等待有可用的并发槽位
   */
  private async waitForSlot(): Promise<void> {
    return new Promise((resolve) => {
      const checkSlot = () => {
        if (this.activeRequests.size < this.config.maxConcurrent) {
          resolve();
        } else {
          setTimeout(checkSlot, 100);
        }
      };
      checkSlot();
    });
  }

  /**
   * 睡眠指定时间
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 生成请求ID
   */
  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * 获取队列状态
   * 🔧 ENHANCED: 添加更多统计信息
   */
  getStatus() {
    const now = Date.now();
    const recentErrors = this.rateLimitErrors.filter(time => now - time < 300000);

    return {
      queueSize: this.queue.length,
      activeRequests: this.activeRequests.size,
      maxConcurrent: this.config.maxConcurrent,
      recentRequests: this.requestHistory.filter(time => now - time < 60000).length,
      lastRequestTime: this.lastRequestTime,
      adaptiveMinInterval: this.adaptiveMinInterval,
      rateLimitErrors: recentErrors.length,
      cacheSize: this.requestCache.size,
      pendingDeduplicated: this.pendingRequests.size
    };
  }

  /**
   * 清空队列
   * 🔧 ENHANCED: 同时清理缓存
   */
  clearQueue(): void {
    this.queue.forEach(request => {
      request.reject(new Error('Queue cleared'));
    });
    this.queue = [];
    this.requestCache.clear();
    this.pendingRequests.clear();
    console.log('✅ Queue, cache, and pending requests cleared');
  }

  /**
   * 更新配置
   */
  updateConfig(newConfig: Partial<RateLimitConfig>): void {
    this.config = { ...this.config, ...newConfig };
    console.log('Request queue config updated:', this.config);
  }
}

// 🔧 REDESIGN (2026-06-12 Phase 3)：全局单例 → per-provider（按上游 hostname）桶池。
// 旧实现所有 provider 共享一个 maxConcurrent=2 / 1.2s 间隔的桶：用户配置了
// 不限速的自建网关，也会被另一家正在退避的 provider 连坐串行。
// 现在每个上游 host 一个独立桶（同 host 内仍保留全部 429 防护与自适应限速），
// 跨 provider 互不阻塞。桶数量有上限，溢出回落到共享缺省桶。
const DEFAULT_QUEUE_CONFIG: Partial<RateLimitConfig> = {
  maxConcurrent: 2,           // 允许2个并发请求（每个上游 host 独立计算）
  requestsPerMinute: 25,      // 每分钟25个请求
  requestsPerSecond: 2,       // 每秒2个请求
  minInterval: 1200,          // 1.2秒间隔
  burstLimit: 4,              // 突发最多4个请求
  adaptiveMode: true,         // 保持自适应模式
  maxRetries: 3,              // 减少重试次数避免阻塞
  backoffMultiplier: 1.5      // 更平滑的退避策略
};

const MAX_QUEUE_BUCKETS = 16;
const FALLBACK_BUCKET_KEY = "__shared__";
const queueBuckets = new Map<string, RequestQueueManager>();
let queueConfigOverride: Partial<RateLimitConfig> = {};

const resolveQueueBucketKey = (url: string): string => {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host || FALLBACK_BUCKET_KEY;
  } catch {
    return FALLBACK_BUCKET_KEY;
  }
};

const getQueueForUrl = (url: string): RequestQueueManager => {
  let key = resolveQueueBucketKey(url);
  if (!queueBuckets.has(key) && queueBuckets.size >= MAX_QUEUE_BUCKETS) {
    key = FALLBACK_BUCKET_KEY;
  }
  let bucket = queueBuckets.get(key);
  if (!bucket) {
    bucket = new RequestQueueManager({
      ...DEFAULT_QUEUE_CONFIG,
      ...queueConfigOverride,
    });
    queueBuckets.set(key, bucket);
  }
  return bucket;
};

// 导出便捷函数
const isLoopbackRequest = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    const host = (parsed.hostname || "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
  } catch {
    return false;
  }
};

export const queuedFetch = (
  url: string,
  options: QueuedRequestInit = {},
  priority: 'high' | 'normal' | 'low' = 'normal',
  userId?: string
): Promise<Response> => {
  // Avoid queue throttling for loopback services (e.g. local built-in API on localhost).
  if (isLoopbackRequest(url)) {
    // 🔧 FIX (2026-06-11 BUG-C5): loopback 直连路径同样支持 timeoutMs（立即执行，
    // 此时创建 timeout signal 没有排队误差）。
    const { timeoutMs, ...rest } = options;
    const signal =
      rest.signal ||
      (typeof timeoutMs === "number" && timeoutMs > 0
        ? AbortSignal.timeout(timeoutMs)
        : undefined);
    return fetch(url, { ...rest, ...(signal ? { signal } : {}) });
  }
  return getQueueForUrl(url).enqueue(url, options, priority, userId);
};

/** 聚合全部桶的状态（per-host 桶池后状态按 host 分组返回） */
export const getQueueStatus = () => {
  const buckets: Record<string, ReturnType<RequestQueueManager["getStatus"]>> = {};
  for (const [key, bucket] of queueBuckets) {
    buckets[key] = bucket.getStatus();
  }
  const totals = Object.values(buckets).reduce(
    (acc, status) => ({
      queueSize: acc.queueSize + status.queueSize,
      activeRequests: acc.activeRequests + status.activeRequests,
      rateLimitErrors: acc.rateLimitErrors + status.rateLimitErrors,
    }),
    { queueSize: 0, activeRequests: 0, rateLimitErrors: 0 }
  );
  return { ...totals, bucketCount: queueBuckets.size, buckets };
};
export const clearRequestQueue = () => {
  for (const bucket of queueBuckets.values()) bucket.clearQueue();
};
export const updateQueueConfig = (config: Partial<RateLimitConfig>) => {
  queueConfigOverride = { ...queueConfigOverride, ...config };
  for (const bucket of queueBuckets.values()) bucket.updateConfig(config);
};

export { RequestQueueManager };
export type { RateLimitConfig };
