/**
 * 请求队列管理器测试
 * 验证429错误处理和自适应速率限制
 *
 * 🔧 FIX (2026-06-11 BUG-A7/C4/A19): 存量 5 条用例全红的根因是 jsdom 测试环境
 * 没有全局 Response 构造器（"ReferenceError: Response is not defined"），以及
 * 用例使用真实速率限制间隔（minInterval 1000ms + getWaitTime 500ms 下限）导致
 * 5s 默认超时。修复：① 注入最小 Response polyfill；② 用例改用快速限速配置并
 * 显式放宽超时；③ 行为断言按新语义更新（429 本层重试 ≤2 次、非幂等请求不去重、
 * abort 不重试、x-md2ppt-no-retry 不重试）。
 */

import { RequestQueueManager } from './request-queue-manager';

// ---- 最小 Response polyfill（jsdom 环境无全局 Response）----
class MockResponse {
  status: number;
  ok: boolean;
  headers: { get: (name: string) => string | null };
  body: null = null;
  private readonly bodyText: string;
  private readonly headerMap: Map<string, string>;

  constructor(
    body: string = '',
    init: { status?: number; headers?: Record<string, string> } = {}
  ) {
    this.bodyText = body || '';
    this.status = init.status ?? 200;
    this.ok = this.status >= 200 && this.status < 300;
    this.headerMap = new Map(
      Object.entries(init.headers || {}).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ])
    );
    this.headers = {
      get: (name: string) => this.headerMap.get(name.toLowerCase()) ?? null,
    };
  }

  clone(): MockResponse {
    return new MockResponse(this.bodyText, {
      status: this.status,
      headers: Object.fromEntries(this.headerMap),
    });
  }

  async text(): Promise<string> {
    return this.bodyText;
  }

  async json(): Promise<any> {
    return JSON.parse(this.bodyText);
  }
}

if (typeof (globalThis as any).Response === 'undefined') {
  (globalThis as any).Response = MockResponse;
}

const okResponse = (body: any = { success: true }) =>
  new MockResponse(JSON.stringify(body), { status: 200 }) as unknown as Response;

const statusResponse = (
  status: number,
  headers: Record<string, string> = {}
) => new MockResponse('', { status, headers }) as unknown as Response;

// 测试用快速限速配置：避免真实 500ms/1000ms 等待导致用例超时
const fastConfig = {
  maxConcurrent: 1,
  requestsPerMinute: 1000,
  requestsPerSecond: 100,
  minInterval: 20,
  burstLimit: 100,
  adaptiveMode: true,
  maxRetries: 3,
  backoffMultiplier: 2,
};

describe('RequestQueueManager - 429 Error Handling', () => {
  let queueManager: RequestQueueManager;

  beforeEach(() => {
    queueManager = new RequestQueueManager({ ...fastConfig });
  });

  test(
    '应该正确处理429错误并自适应调整速率（本层重试后成功）',
    async () => {
      // Mock fetch to simulate 429 error
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(statusResponse(429))
        .mockResolvedValueOnce(statusResponse(429))
        .mockResolvedValueOnce(okResponse());

      const response = await queueManager.enqueue(
        'https://api.example.com/test',
        {},
        'normal',
        'user123'
      );

      expect(response.status).toBe(200);
      // 🔧 BUG-A19: 两次 429 在本层（≤2 次预算内）被退避重试
      expect(global.fetch).toHaveBeenCalledTimes(3);

      const status = queueManager.getStatus();
      expect(status.rateLimitErrors).toBeGreaterThan(0);
      expect(status.adaptiveMinInterval).toBeGreaterThan(fastConfig.minInterval);
    },
    20000
  );

  test(
    '应该对相同的幂等请求进行去重，且各调用方拿到可独立消费的 clone',
    async () => {
      global.fetch = jest.fn().mockResolvedValue(okResponse());

      // 发起两个相同的请求（POST 但 URL 不在非幂等清单内，仍可去重）
      const options = {
        method: 'POST',
        body: JSON.stringify({ prompt: 'test' }),
      };
      const promise1 = queueManager.enqueue(
        'https://api.example.com/test',
        { ...options },
        'normal',
        'user123'
      );
      const promise2 = queueManager.enqueue(
        'https://api.example.com/test',
        { ...options },
        'normal',
        'user123'
      );

      const [res1, res2] = await Promise.all([promise1, promise2]);

      // 应该只调用一次fetch（去重）
      expect(global.fetch).toHaveBeenCalledTimes(1);
      // 🔧 BUG-C4: 去重命中返回 clone，两个调用方都能独立读 body
      await expect(res1.text()).resolves.toContain('success');
      await expect(res2.text()).resolves.toContain('success');
    },
    20000
  );

  test(
    '🔧 BUG-A7: 非幂等生成类 POST 不缓存也不去重',
    async () => {
      global.fetch = jest.fn().mockResolvedValue(okResponse());

      const options = {
        method: 'POST',
        body: JSON.stringify({ prompt: 'same prompt' }),
      };
      const promise1 = queueManager.enqueue(
        'https://api.example.com/v1/chat/completions',
        { ...options },
        'normal',
        'user123'
      );
      const promise2 = queueManager.enqueue(
        'https://api.example.com/v1/chat/completions',
        { ...options },
        'normal',
        'user123'
      );
      await Promise.all([promise1, promise2]);

      // 两次都必须真实打到上游（不去重）
      expect(global.fetch).toHaveBeenCalledTimes(2);

      // 也不会写入响应缓存：第三次仍然真实请求
      await queueManager.enqueue(
        'https://api.example.com/v1/chat/completions',
        { ...options },
        'normal',
        'user123'
      );
      expect(global.fetch).toHaveBeenCalledTimes(3);
      expect(queueManager.getStatus().cacheSize).toBe(0);
    },
    20000
  );

  test(
    '应该在成功后逐渐恢复速率',
    async () => {
      global.fetch = jest.fn().mockResolvedValue(okResponse());

      // 先模拟 429 之后被调高的间隔
      (queueManager as any)['adaptiveMinInterval'] = 300;

      for (let i = 0; i < 3; i++) {
        await queueManager.enqueue(
          `https://api.example.com/recover-${i}`,
          {},
          'normal',
          'user123'
        );
      }

      const status = queueManager.getStatus();
      // 速率应该逐渐恢复（间隔减少）
      expect(status.adaptiveMinInterval).toBeLessThan(300);
    },
    20000
  );

  test(
    '应该遵守并发限制',
    async () => {
      let activeRequests = 0;
      let maxConcurrent = 0;

      global.fetch = jest.fn().mockImplementation(async () => {
        activeRequests++;
        maxConcurrent = Math.max(maxConcurrent, activeRequests);
        await new Promise((resolve) => setTimeout(resolve, 50));
        activeRequests--;
        return okResponse();
      });

      const promises = [];
      for (let i = 0; i < 4; i++) {
        promises.push(
          queueManager.enqueue(
            `https://api.example.com/concurrent-${i}`,
            {},
            'normal',
            'user123'
          )
        );
      }
      await Promise.all(promises);

      expect(maxConcurrent).toBeLessThanOrEqual(1);
    },
    30000
  );

  test(
    '🔧 BUG-A19: 持续429应在本层重试2次后失败，错误注明已重试并带 Retry-After',
    async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue(statusResponse(429, { 'retry-after': '1' }));

      const promise = queueManager.enqueue(
        'https://api.example.com/test',
        {},
        'normal',
        'user123'
      );

      await expect(promise).rejects.toThrow(/已重试/);
      // 初始 1 次 + 本层重试 2 次 = 3 次，不再叠加 maxRetries(3) 的全量预算
      expect(global.fetch).toHaveBeenCalledTimes(3);

      const error: any = await promise.catch((err: any) => err);
      expect(error.status).toBe(429);
      expect(error.retryAfterSeconds).toBe(1);
      expect(error.alreadyRetried).toBe(true);
    },
    20000
  );

  test(
    '🔧 BUG-C4: 已 abort 的请求失败后立即 reject，不进入重试',
    async () => {
      const controller = new AbortController();
      controller.abort();

      const abortError = new Error('This operation was aborted');
      abortError.name = 'AbortError';
      global.fetch = jest.fn().mockImplementation(async (_url, init: any) => {
        if (init?.signal?.aborted) throw abortError;
        return okResponse();
      });

      await expect(
        queueManager.enqueue(
          'https://api.example.com/v1/chat/completions',
          { method: 'POST', signal: controller.signal },
          'normal',
          'user123'
        )
      ).rejects.toThrow(/aborted/i);

      // 不重试：只调用一次 fetch
      expect(global.fetch).toHaveBeenCalledTimes(1);
    },
    20000
  );

  test(
    '🔧 BUG-A6: 带 x-md2ppt-no-retry 头的 5xx 响应不重试，直接交给调用方',
    async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue(statusResponse(502, { 'x-md2ppt-no-retry': '1' }));

      const response = await queueManager.enqueue(
        'https://api.example.com/test',
        {},
        'normal',
        'user123'
      );

      expect(response.status).toBe(502);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    },
    20000
  );
});
