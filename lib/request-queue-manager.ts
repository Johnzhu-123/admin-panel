/**
 * 请求队列管理器
 * 防止并发请求导致 429 错误和 IP 风控
 * 🔧 ENHANCED: 添加自适应速率限制和智能重试机制
 */

interface QueuedRequest {
  id: string;
  url: string;
  options: RequestInit;
  resolve: (value: Response) => void;
  reject: (reason: any) => void;
  timestamp: number;
  retryCount: number;
  priority: 'high' | 'normal' | 'low';
  userId?: string;              // 用户ID，用于去重和统计
  requestHash?: string;         // 请求哈希，用于去重
}

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
  }

  /**
   * 添加请求到队列
   * 🔧 ENHANCED: 添加请求去重和缓存检查
   */
  async enqueue(
    url: string,
    options: RequestInit = {},
    priority: 'high' | 'normal' | 'low' = 'normal',
    userId?: string
  ): Promise<Response> {
    // 🔧 NEW: 生成请求哈希用于去重
    const requestHash = this.generateRequestHash(url, options);

    // 🔧 NEW: 检查缓存
    const cached = this.requestCache.get(requestHash);
    if (cached && Date.now() - cached.timestamp < 60000) { // 1分钟缓存
      console.log(`✅ Cache hit for request: ${requestHash.substring(0, 8)}`);
      return cached.response.clone();
    }

    // 🔧 NEW: 检查是否有相同的请求正在进行（去重）
    const pending = this.pendingRequests.get(requestHash);
    if (pending) {
      console.log(`⏳ Deduplicating request: ${requestHash.substring(0, 8)}`);
      return pending;
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

    // 记录进行中的请求
    this.pendingRequests.set(requestHash, requestPromise);

    // 请求完成后清理
    requestPromise.finally(() => {
      this.pendingRequests.delete(requestHash);
    });

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

    try {
      const response = await fetch(request.url, request.options);

      // 🔧 NEW: 检查429错误并自适应调整
      if (response.status === 429) {
        this.handle429Error(request);
        return;
      }

      // 🔧 NEW: 成功请求后逐渐恢复速率
      if (response.ok && this.config.adaptiveMode) {
        this.adjustRateLimitOnSuccess();
      }

      // 检查是否需要重试
      if (this.shouldRetry(response, request)) {
        await this.retryRequest(request);
      } else {
        // 🔧 NEW: 缓存成功的响应
        if (response.ok && request.requestHash) {
          this.requestCache.set(request.requestHash, {
            response: response.clone(),
            timestamp: Date.now()
          });
        }
        request.resolve(response);
      }
    } catch (error) {
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
   */
  private handle429Error(request: QueuedRequest): void {
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

    // 重试请求
    if (request.retryCount < this.config.maxRetries) {
      this.retryRequest(request);
    } else {
      console.error(`❌ Request ${request.id} exceeded max retries after 429 errors`);
      request.reject(new Error('Rate limit exceeded after maximum retries'));
    }
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

// 全局单例实例 - 🔧 UPDATED: 优化配置减少 429/502/504 错误
const globalRequestQueue = new RequestQueueManager({
  maxConcurrent: 2,           // 🔧 INCREASED: 允许2个并发请求
  requestsPerMinute: 25,      // 🔧 INCREASED: 每分钟25个请求
  requestsPerSecond: 2,       // 🔧 INCREASED: 每秒2个请求
  minInterval: 1200,          // 🔧 REDUCED: 1.2秒间隔
  burstLimit: 4,              // 🔧 INCREASED: 突发最多4个请求
  adaptiveMode: true,         // 保持自适应模式
  maxRetries: 3,              // 🔧 REDUCED: 减少重试次数避免阻塞
  backoffMultiplier: 1.5      // 🔧 REDUCED: 更平滑的退避策略
});

// 导出便捷函数
export const queuedFetch = (
  url: string,
  options: RequestInit = {},
  priority: 'high' | 'normal' | 'low' = 'normal',
  userId?: string
): Promise<Response> => {
  return globalRequestQueue.enqueue(url, options, priority, userId);
};

export const getQueueStatus = () => globalRequestQueue.getStatus();
export const clearRequestQueue = () => globalRequestQueue.clearQueue();
export const updateQueueConfig = (config: Partial<RateLimitConfig>) =>
  globalRequestQueue.updateConfig(config);

export { RequestQueueManager };
export type { RateLimitConfig };