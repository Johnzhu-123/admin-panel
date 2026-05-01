/**
 * 请求队列管理器测试
 * 验证429错误处理和自适应速率限制
 */

import { RequestQueueManager } from './request-queue-manager';

describe('RequestQueueManager - 429 Error Handling', () => {
  let queueManager: RequestQueueManager;

  beforeEach(() => {
    queueManager = new RequestQueueManager({
      maxConcurrent: 1,
      requestsPerMinute: 10,
      requestsPerSecond: 1,
      minInterval: 1000,
      burstLimit: 2,
      adaptiveMode: true,
      maxRetries: 3,
      backoffMultiplier: 2
    });
  });

  test('应该正确处理429错误并自适应调整速率', async () => {
    // Mock fetch to simulate 429 error
    global.fetch = jest.fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));

    const promise = queueManager.enqueue('https://api.example.com/test', {}, 'normal', 'user123');
    
    // 等待请求完成
    const response = await promise;
    
    expect(response.status).toBe(200);
    
    // 检查状态
    const status = queueManager.getStatus();
    expect(status.rateLimitErrors).toBeGreaterThan(0);
    expect(status.adaptiveMinInterval).toBeGreaterThan(1000); // 应该增加了间隔
  });

  test('应该对相同请求进行去重', async () => {
    global.fetch = jest.fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));

    // 发起两个相同的请求
    const promise1 = queueManager.enqueue('https://api.example.com/test', { method: 'POST', body: JSON.stringify({ prompt: 'test' }) }, 'normal', 'user123');
    const promise2 = queueManager.enqueue('https://api.example.com/test', { method: 'POST', body: JSON.stringify({ prompt: 'test' }) }, 'normal', 'user123');
    
    await Promise.all([promise1, promise2]);
    
    // 应该只调用一次fetch（去重）
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('应该在成功后逐渐恢复速率', async () => {
    global.fetch = jest.fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));

    // 先触发429错误调整速率
    queueManager['adaptiveMinInterval'] = 5000;
    
    // 发起多个成功请求
    for (let i = 0; i < 5; i++) {
      await queueManager.enqueue(`https://api.example.com/test${i}`, {}, 'normal', 'user123');
    }
    
    const status = queueManager.getStatus();
    // 速率应该逐渐恢复（间隔减少）
    expect(status.adaptiveMinInterval).toBeLessThan(5000);
  });

  test('应该遵守并发限制', async () => {
    let activeRequests = 0;
    let maxConcurrent = 0;

    global.fetch = jest.fn().mockImplementation(async () => {
      activeRequests++;
      maxConcurrent = Math.max(maxConcurrent, activeRequests);
      await new Promise(resolve => setTimeout(resolve, 100));
      activeRequests--;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });

    // 发起多个并发请求
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(queueManager.enqueue(`https://api.example.com/test${i}`, {}, 'normal', 'user123'));
    }
    
    await Promise.all(promises);
    
    // 最大并发数不应超过配置的限制
    expect(maxConcurrent).toBeLessThanOrEqual(1);
  });

  test('应该在达到最大重试次数后失败', async () => {
    global.fetch = jest.fn()
      .mockResolvedValue(new Response('', { status: 429 }));

    const promise = queueManager.enqueue('https://api.example.com/test', {}, 'normal', 'user123');
    
    await expect(promise).rejects.toThrow('Rate limit exceeded after maximum retries');
  });
});
