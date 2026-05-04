/**
 * API Proxy Layer
 * Handles secure API request proxying for built-in services
 * Validates: Requirements 2.1, 2.2, 5.4
 */

import {
  ProxyImageRequest,
  UsageRecord,
  BuiltInServiceConfig,
  BuiltInServiceError,
  BuiltInServiceErrorCodes
} from '../types';
import { 
  APIProxyLayer,
  BuiltInServiceConfigManager, 
  UserAuthorizationVerifier 
} from '../interfaces';
import {
  generateImageWithCompatibility,
  handleCompatibilityError,
  initializeCompatibilitySystem
} from '../../api-compatibility/integration';
import { coerceImageValueToBase64 } from '../../image-generation/shared-utils';
import { pickOpenAiImageSize } from '../../ai';
import { recordFailureLog } from '../../diagnostics';
import { TIMEOUTS, RETRY_CONFIG, SECURITY_SETTINGS } from '../config';
import { getPerformanceMonitor } from './performance-monitor';
import { getAuditLogger, logAPIRequest, logServiceAccess, logSecurityEvent } from './audit-logger';
import { getPerformanceOptimizer } from './performance-optimizer';
import { getSecurityEnhancer } from './security-enhancer';
import { queuedFetch } from '../../request-queue-manager'; // 🔧 NEW: 导入请求队列管理器

export class APIProxyLayerImpl implements APIProxyLayer {
  private activeRequests = new Map<string, AbortController>();
  private usageRecords: UsageRecord[] = [];
  private dailyUsageStats = new Map<string, { date: string; requests: number; }>();
  private serviceHealthCache = new Map<string, { isHealthy: boolean; lastChecked: Date; }>();
  private performanceMonitor: any; // Will be initialized in constructor
  private auditLogger: any; // Will be initialized in constructor
  private performanceOptimizer: any; // Will be initialized in constructor
  private securityEnhancer: any; // Will be initialized in constructor

  constructor(
    private configManager: BuiltInServiceConfigManager,
    private authVerifier: UserAuthorizationVerifier
  ) {
    // Initialize the compatibility system
    initializeCompatibilitySystem();
    
    // Initialize performance monitoring
    this.performanceMonitor = getPerformanceMonitor();
    
    // Initialize audit logging
    this.auditLogger = getAuditLogger();
    
    // Initialize performance optimizer
    this.performanceOptimizer = getPerformanceOptimizer();
    
    // Initialize security enhancer
    this.securityEnhancer = getSecurityEnhancer();
    
    // Clean up old usage records periodically
    setInterval(() => this.cleanupOldRecords(), 60 * 60 * 1000); // Every hour
  }

  /**
   * Proxy image generation request through built-in service
   */
  async proxyImageGeneration(request: ProxyImageRequest): Promise<any> {
    const requestId = this.generateRequestId();
    const startTime = Date.now();

    // Use performance optimizer to execute the request
    return this.performanceOptimizer.executeOptimizedRequest(
      request,
      async (optimizedRequest: ProxyImageRequest) => {
        // Start performance monitoring
        this.performanceMonitor.startRequest(requestId, optimizedRequest.userId, optimizedRequest.serviceId);

        // Log request start
        this.auditLogger.logRequest('info', 'proxy_request_started', requestId, optimizedRequest.userId, optimizedRequest.serviceId, {
          prompt: optimizedRequest.prompt.substring(0, 100) + (optimizedRequest.prompt.length > 100 ? '...' : ''),
          model: optimizedRequest.model,
          size: optimizedRequest.size
        });

        // Security validation and sanitization
        const securityResult = await this.securityEnhancer.validateRequest({
          userId: optimizedRequest.userId,
          serviceId: optimizedRequest.serviceId,
          prompt: optimizedRequest.prompt,
          metadata: {
            // In a real implementation, these would come from the request headers
            ipAddress: 'unknown',
            userAgent: 'unknown',
            sessionId: requestId
          }
        });

        if (!securityResult.isValid) {
          // Log security violation
          this.auditLogger.logRequest('error', 'security_validation_failed', requestId, optimizedRequest.userId, optimizedRequest.serviceId, {
            reason: securityResult.reason,
            threat: securityResult.threat
          });

          throw new BuiltInServiceError(
            BuiltInServiceErrorCodes.PERMISSION_DENIED,
            securityResult.reason || 'Security validation failed'
          );
        }

        // Use sanitized prompt if available
        if (securityResult.sanitizedPrompt) {
          optimizedRequest.prompt = securityResult.sanitizedPrompt;
        }

        try {
          // Validate the proxy request
          this.performanceMonitor.startAuth(requestId);
          const isValid = await this.validateProxyRequest(optimizedRequest);
          if (!isValid) {
            // Log validation failure
            this.auditLogger.logRequest('warn', 'proxy_request_validation_failed', requestId, optimizedRequest.userId, optimizedRequest.serviceId, {
              reason: 'Invalid proxy request or insufficient permissions'
            });
            
            throw new BuiltInServiceError(
              BuiltInServiceErrorCodes.PERMISSION_DENIED,
              'Invalid proxy request or insufficient permissions'
            );
          }

          // Log successful validation
          this.auditLogger.logRequest('info', 'proxy_request_validated', requestId, optimizedRequest.userId, optimizedRequest.serviceId);

          // Get service configuration
          const serviceConfig = await this.configManager.getBuiltInServiceConfig(optimizedRequest.serviceId);
          if (!serviceConfig) {
            throw new BuiltInServiceError(
              BuiltInServiceErrorCodes.SERVICE_NOT_FOUND,
              `Service not found: ${optimizedRequest.serviceId}`
            );
          }

          if (!serviceConfig.isEnabled) {
            throw new BuiltInServiceError(
              BuiltInServiceErrorCodes.SERVICE_UNAVAILABLE,
              `Service is disabled: ${optimizedRequest.serviceId}`
            );
          }

          // Check service availability
          const isAvailable = await this.configManager.isServiceAvailable(optimizedRequest.serviceId);
          if (!isAvailable) {
            throw new BuiltInServiceError(
              BuiltInServiceErrorCodes.SERVICE_UNAVAILABLE,
              `Service is currently unavailable: ${optimizedRequest.serviceId}`
            );
          }

          // Create abort controller for this request
          const controller = new AbortController();
          this.activeRequests.set(requestId, controller);

          // Set up timeout
          const timeoutId = setTimeout(() => {
            controller.abort();
          }, TIMEOUTS.API_REQUEST);

          try {
            // Start proxy phase monitoring
            this.performanceMonitor.startProxy(requestId);
            
            // Get optimized connection
            const connection = await this.performanceOptimizer.getConnection(
              optimizedRequest.serviceId, 
              serviceConfig.baseUrl
            );
            
            // Proxy the request through the compatibility system
            const response = await this.proxyThroughCompatibilitySystem(
              optimizedRequest,
              serviceConfig,
              controller.signal
            );

            clearTimeout(timeoutId);
            
            // Calculate request/response sizes for monitoring
            const requestSize = JSON.stringify(optimizedRequest).length;
            const responseSize = JSON.stringify(response).length;
            
            // Complete performance monitoring
            this.performanceMonitor.completeRequest(
              requestId,
              true, // success
              requestSize,
              responseSize
            );
            
            // Record successful usage
            await this.recordUsage(optimizedRequest.userId, optimizedRequest.serviceId, {
              requestId,
              userId: optimizedRequest.userId,
              serviceId: optimizedRequest.serviceId,
              timestamp: new Date(),
              success: true,
              responseTime: Date.now() - startTime
            });

            // Log successful completion
            logAPIRequest(requestId, optimizedRequest.userId, optimizedRequest.serviceId, true, Date.now() - startTime, {
              responseSize,
              model: optimizedRequest.model,
              cached: false // Will be set to true by performance optimizer if cached
            });

            return response;
          } catch (error) {
            clearTimeout(timeoutId);
            
            // Calculate request size for monitoring
            const requestSize = JSON.stringify(optimizedRequest).length;
            const errorType = error instanceof BuiltInServiceError ? 
              error.code : (error instanceof Error ? error.constructor.name : 'UnknownError');
            
            // Complete performance monitoring with error
            this.performanceMonitor.completeRequest(
              requestId,
              false, // success = false
              requestSize,
              0, // no response size on error
              errorType
            );
            
            // Record failed usage
            await this.recordUsage(optimizedRequest.userId, optimizedRequest.serviceId, {
              requestId,
              userId: optimizedRequest.userId,
              serviceId: optimizedRequest.serviceId,
              timestamp: new Date(),
              success: false,
              responseTime: Date.now() - startTime,
              error: error instanceof Error ? error.message : 'Unknown error'
            });

            // Log failed request
            logAPIRequest(requestId, optimizedRequest.userId, optimizedRequest.serviceId, false, Date.now() - startTime, {
              errorType,
              errorMessage: error instanceof Error ? error.message : 'Unknown error'
            });

            // Record failure in diagnostics system
            recordFailureLog({
              provider: `built-in-${serviceConfig.provider}`,
              operation: 'image-generation',
              url: serviceConfig.baseUrl,
              status: null,
              requestBody: {
                prompt: optimizedRequest.prompt,
                model: optimizedRequest.model,
                size: optimizedRequest.size,
                serviceId: optimizedRequest.serviceId
              },
              responseBody: error instanceof Error ? error.message : 'Unknown error'
            });

            throw error;
          } finally {
            this.activeRequests.delete(requestId);
          }
        } catch (error) {
          console.error('Error in proxy image generation:', error);
          
          // Complete performance monitoring with error if not already completed
          if (this.activeRequests.has(requestId)) {
            const requestSize = JSON.stringify(optimizedRequest).length;
            const errorType = error instanceof BuiltInServiceError ? 
              error.code : (error instanceof Error ? error.constructor.name : 'UnknownError');
            
            this.performanceMonitor.completeRequest(
              requestId,
              false,
              requestSize,
              0,
              errorType
            );
          }
          
          if (error instanceof BuiltInServiceError) {
            throw error;
          }

          // 🔧 FIX (2026-05 #12 root cause of "An unexpected error occurred"):
          //   旧实现一律调 handleCompatibilityError(error) 然后用 errorInfo.userMessage
          //   作为 BuiltInServiceError.message。errorInfo.userMessage 在 unknown
          //   分支上就是 "An unexpected error occurred. Please try again."，把上游真实
          //   状态码 / 错误体彻底吞了。
          //   新策略：
          //     1) 优先把 APIError（含 status / bodyPreview / 真实 message）的诊断
          //        信息拼到 BuiltInServiceError.message，前端才看得到上游原因。
          //     2) 同时把结构化诊断放到 details.upstream，route.ts 可以直接透出。
          //     3) 仍然调用 handleCompatibilityError 收集建议，但作为辅助而非覆盖。
          if (error && typeof error === 'object' && 'message' in error) {
            const errorInfo = handleCompatibilityError(error);
            const apiErr = error as any;
            const upstreamStatus = apiErr?.response?.status;
            const upstreamStatusText = apiErr?.response?.statusText;
            const upstreamBodyPreview = apiErr?.response?.bodyPreview;
            const upstreamRawMessage = typeof apiErr?.message === 'string' ? apiErr.message : '';
            const upstreamCause = apiErr?.cause || apiErr?.response?.cause;
            const upstreamErrorName = apiErr?.name || apiErr?.constructor?.name;

            // Pick the best-available message. 真实上游消息 > userMessage 兜底。
            // 🔧 FIX (2026-05 #14): rawMessage 即便等于 "Unknown error occurred" 也尽量从
            //   error 自身的别的字段（name/type/code/cause）拼出可诊断的字符串，避免再次落到
            //   笼统提示。
            const fallbackHints: string[] = [];
            if (upstreamErrorName && upstreamErrorName !== 'Error') fallbackHints.push(`name=${upstreamErrorName}`);
            if (apiErr?.type) fallbackHints.push(`type=${apiErr.type}`);
            if (apiErr?.code) fallbackHints.push(`code=${apiErr.code}`);
            if (typeof upstreamStatus === 'number') fallbackHints.push(`status=${upstreamStatus}`);
            if (upstreamCause) {
              const causeMsg = typeof (upstreamCause as any)?.message === 'string' ? (upstreamCause as any).message : '';
              const causeCode = typeof (upstreamCause as any)?.code === 'string' ? (upstreamCause as any).code : '';
              if (causeMsg || causeCode) fallbackHints.push(`cause=${[causeCode, causeMsg].filter(Boolean).join(' ')}`);
            }
            const enhancedRawMessage = fallbackHints.length
              ? `${upstreamRawMessage} | ${fallbackHints.join(' ')}`
              : upstreamRawMessage;

            const finalMessage = (enhancedRawMessage && enhancedRawMessage !== 'Unknown error occurred')
              ? `[v16] ${enhancedRawMessage}`
              : `[v16] ${errorInfo.userMessage}`;

            console.error(
              '[built-in-proxy v16] upstream image generation failed:',
              JSON.stringify({
                serviceId: optimizedRequest.serviceId,
                model: optimizedRequest.model,
                size: optimizedRequest.size,
                upstreamStatus,
                upstreamStatusText,
                upstreamBodyPreview,
                rawMessage: upstreamRawMessage,
                friendlyMessage: errorInfo.userMessage
              })
            );

            throw new BuiltInServiceError(
              BuiltInServiceErrorCodes.PROXY_ERROR,
              finalMessage,
              {
                technicalDetails: errorInfo.technicalDetails,
                suggestions: errorInfo.suggestions,
                version: 'v15',
                upstream: {
                  status: upstreamStatus,
                  statusText: upstreamStatusText,
                  bodyPreview: upstreamBodyPreview,
                  rawMessage: upstreamRawMessage,
                  enhancedRawMessage,
                  hints: fallbackHints
                }
              }
            );
          }

          throw new BuiltInServiceError(
            BuiltInServiceErrorCodes.PROXY_ERROR,
            `Proxy request failed: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      }
    );
  }

  /**
   * Validate proxy request
   */
  async validateProxyRequest(request: ProxyImageRequest): Promise<boolean> {
    try {
      // Validate request structure
      if (!request.userId || !request.serviceId || !request.prompt) {
        console.log('Invalid request structure:', { 
          hasUserId: !!request.userId, 
          hasServiceId: !!request.serviceId, 
          hasPrompt: !!request.prompt 
        });
        return false;
      }

      // Validate prompt length
      if (request.prompt.length > 10000) { // 10KB limit
        console.log('Prompt too long:', request.prompt.length);
        return false;
      }

      // Check user authorization
      const authResult = await this.authVerifier.validateServiceAccess(request.userId, request.serviceId);
      if (!authResult.allowed) {
        console.log('User not authorized:', authResult.reason);
        
        // Log security event for unauthorized access attempt
        logSecurityEvent('unauthorized_access_attempt', request.userId, {
          serviceId: request.serviceId,
          reason: authResult.reason,
          requestId: 'validation-phase'
        });
        
        return false;
      }

      // Log successful authorization
      logServiceAccess(request.userId, request.serviceId, 'authorization_granted', true, {
        allowed: authResult.allowed
      });

      // Check concurrent request limits
      const userActiveRequests = Array.from(this.activeRequests.values()).length;
      if (userActiveRequests >= SECURITY_SETTINGS.MAX_CONCURRENT_REQUESTS) {
        console.log('Too many concurrent requests:', userActiveRequests);
        return false;
      }

      return true;
    } catch (error) {
      console.error('Error validating proxy request:', error);
      return false;
    }
  }

  /**
   * Record usage statistics
   */
  async recordUsage(userId: string, serviceId: string, usage: UsageRecord): Promise<void> {
    try {
      // Store usage record in memory (for backward compatibility)
      this.usageRecords.push(usage);

      // Keep only recent records (last 1000)
      if (this.usageRecords.length > 1000) {
        this.usageRecords = this.usageRecords.slice(-1000);
      }

      // Update daily usage statistics in memory
      const today = new Date().toISOString().split('T')[0];
      const userDailyKey = `${userId}-${today}`;
      const serviceDailyKey = `${serviceId}-${today}`;
      
      this.updateDailyStats(userDailyKey);
      this.updateDailyStats(serviceDailyKey);

      // 🔧 NEW: Record usage to database for persistent tracking
      const { recordUsageToDatabase } = await import('../db');
      await recordUsageToDatabase(
        usage.requestId,
        userId,
        serviceId,
        usage.success,
        usage.responseTime,
        usage.error
      );

      // Log usage for monitoring
      console.log(`Usage recorded: ${userId}@${serviceId} - ${usage.success ? 'SUCCESS' : 'FAILED'} (${usage.responseTime}ms)`);
      
      // Log detailed usage for analytics
      if (usage.success) {
        console.log(`✅ Built-in API Success: User=${userId}, Service=${serviceId}, Time=${usage.responseTime}ms`);
      } else {
        console.error(`❌ Built-in API Failure: User=${userId}, Service=${serviceId}, Error=${usage.error}`);
      }
    } catch (error) {
      console.error('Error recording usage:', error);
      // Don't throw error here to avoid breaking the main request flow
    }
  }

  /**
   * Update daily usage statistics
   */
  private updateDailyStats(key: string): void {
    const today = new Date().toISOString().split('T')[0];
    const existing = this.dailyUsageStats.get(key);
    
    if (existing && existing.date === today) {
      existing.requests++;
    } else {
      this.dailyUsageStats.set(key, { date: today, requests: 1 });
    }
  }

  /**
   * Clean up old usage records and statistics
   */
  private cleanupOldRecords(): void {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    // Clean up old usage records (keep last 24 hours)
    this.usageRecords = this.usageRecords.filter(record => 
      record.timestamp > oneDayAgo
    );

    // Clean up old daily stats (keep last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const cutoffDate = sevenDaysAgo.toISOString().split('T')[0];
    
    for (const [key, stats] of this.dailyUsageStats.entries()) {
      if (stats.date < cutoffDate) {
        this.dailyUsageStats.delete(key);
      }
    }

    // Clean up old health cache (keep last 5 minutes)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    for (const [serviceId, health] of this.serviceHealthCache.entries()) {
      if (health.lastChecked < fiveMinutesAgo) {
        this.serviceHealthCache.delete(serviceId);
      }
    }

    console.log(`Cleaned up usage records: ${this.usageRecords.length} records remaining`);
  }

  /**
   * Check service health
   */
  async checkServiceHealth(serviceId: string): Promise<boolean> {
    try {
      // Check cache first
      const cached = this.serviceHealthCache.get(serviceId);
      if (cached && (Date.now() - cached.lastChecked.getTime()) < 60000) { // 1 minute cache
        return cached.isHealthy;
      }

      const serviceConfig = await this.configManager.getBuiltInServiceConfig(serviceId);
      if (!serviceConfig || !serviceConfig.isEnabled) {
        this.serviceHealthCache.set(serviceId, { isHealthy: false, lastChecked: new Date() });
        return false;
      }

      // Check if service is available through config manager
      const isAvailable = await this.configManager.isServiceAvailable(serviceId);
      
      // Update cache
      this.serviceHealthCache.set(serviceId, { isHealthy: isAvailable, lastChecked: new Date() });
      
      return isAvailable;
    } catch (error) {
      console.error(`Error checking service health for ${serviceId}:`, error);
      this.serviceHealthCache.set(serviceId, { isHealthy: false, lastChecked: new Date() });
      return false;
    }
  }

  /**
   * Proxy request through compatibility system
   * 🔧 ENHANCED: 传递userId用于请求队列管理
   */
  private async proxyThroughCompatibilitySystem(
    request: ProxyImageRequest,
    serviceConfig: BuiltInServiceConfig,
    signal: AbortSignal
  ): Promise<any> {
    try {
      // Map built-in service to compatibility system parameters
      const authType = this.getAuthTypeForProvider(serviceConfig.provider, serviceConfig.baseUrl);

      // 🔧 FIX (2026-05 #12): 桌面端会把 aspectRatio（"16:9"）或 Gemini 风格尺寸
      //   ("1K"/"2K"/"auto") 直接当作 size 透传过来，OpenAI 兼容上游（gpt-image-2 等）
      //   收到非 \d+x\d+ 的 size 会直接 502/400，且很多上游错误体没有标准 error 字段，
      //   就会被当成 "Unknown error" 包成 "An unexpected error occurred"。
      //   这里在调用兼容层之前先把 size 规范化成 OpenAI 风格 WxH。
      const sanitizedSize = this.sanitizeImageSize(request.size);

      // 🔧 FIX (2026-05 #12): quality 是少数上游会拒绝的字段（Stability/Replicate/部分
      //   自建中转），桌面端默认不传，前端也很少显式传。仅当用户明确给出 "standard"/"hd"
      //   时才向上游传递，其它值丢弃避免触发 400。
      const sanitizedQuality = this.sanitizeQuality(request.quality);

      // Use the compatibility system to handle the request
      const response = await generateImageWithCompatibility(
        request.prompt,
        serviceConfig.apiKey,
        serviceConfig.baseUrl,
        {
          model: request.model || serviceConfig.model,
          size: sanitizedSize,
          ...(sanitizedQuality ? { quality: sanitizedQuality } : {}),
          response_format: request.response_format || 'b64_json',
          n: request.n || 1,
          authType,
          providerId: serviceConfig.id,
          providerName: serviceConfig.name,
          userId: request.userId // 🔧 NEW: 传递userId用于请求队列
        }
      );

      // Transform response to expected format
      if (response.images && response.images.length > 0) {
        const image = response.images[0];
        // 🔧 FIX (2026-05 #6 反复修复的"破坏缩略图 / 当前页生成失败"根因):
        // 第 5 次修复（92e41fd）已经处理 "上游返回 URL → 服务端 fetch 转 base64" 路径，
        // 但漏了关键一环：URL fetch 200 不等于内容是图片 —— 可能是 HTML 登录页 /
        // JSON 错误体 / 0 字节占位。Buffer.toString('base64') 仍会产出"看似合法但
        // 解码非图片"的 base64，前端 <img> 渲染必然失败 → 破图缩略图。
        // 第 6 次修复在 coerceImageValueToBase64 里加了 Content-Type + magic-byte
        // 双重校验；此处把上游响应原貌打到错误诊断里，避免下次又只能盲修。
        const rawB64 = typeof image.b64_json === "string" ? image.b64_json : "";
        const rawUrl = typeof image.url === "string" ? image.url : "";
        const rawValue = rawB64 || rawUrl || "";
        const imageBase64 = await coerceImageValueToBase64(rawValue);
        if (!imageBase64) {
          const diag = {
            hasB64: !!rawB64,
            b64Len: rawB64.length,
            b64Head: rawB64.slice(0, 80),
            hasUrl: !!rawUrl,
            urlHead: rawUrl.slice(0, 200),
            otherKeys: Object.keys(image || {}),
          };
          console.error(
            "[built-in-service] coerce 失败，上游响应不可用:",
            JSON.stringify(diag)
          );
          throw new Error(
            `Failed to extract image data from upstream (b64_json/url both unusable). diag=${JSON.stringify(diag)}`
          );
        }
        return {
          imageBase64,
          revised_prompt: image.revised_prompt,
          metadata: {
            serviceId: request.serviceId,
            provider: serviceConfig.provider,
            model: request.model || serviceConfig.model,
            processingTime: 0, // Will be calculated by caller
            builtInService: true
          }
        };
      }

      throw new Error('No image data in response');
    } catch (error) {
      console.error('Error proxying through compatibility system:', error);
      throw error;
    }
  }

  /**
   * Get authentication type for provider
   */
  private getAuthTypeForProvider(provider: string, baseUrl?: string): 'bearer' | 'api_key' | 'custom_header' {
    switch (provider.toLowerCase()) {
      case 'openai':
        return 'bearer';
      case 'gemini':
        // For third-party OpenAI-compatible Gemini APIs, use bearer token
        // Check if we have a custom base URL (indicating third-party API)
        if (baseUrl && !baseUrl.includes('generativelanguage.googleapis.com')) {
          return 'bearer'; // Third-party OpenAI-compatible API
        }
        return 'api_key'; // Official Google API
      case 'claude':
        return 'bearer';
      default:
        return 'bearer';
    }
  }

  /**
   * 🔧 NEW (2026-05 #12): 把任意 size 输入归一化成 OpenAI 兼容的 WxH 字符串。
   *   桌面端 / 桥接层会传：
   *     - "1792x1024" / "1024x1024" / "2048x1152"  → 直接保留
   *     - "16:9" / "9:16" / "3:4" / "1:1"          → pickOpenAiImageSize 转换
   *     - "1K" / "2K" / "auto" / undefined         → 落到默认 1024x1024
   *   注意：保留 4K 以上自定义分辨率（gpt-image-2 实测支持 2048x1152）。
   */
  private sanitizeImageSize(input?: string): string {
    const raw = (input || '').trim();
    if (!raw) return pickOpenAiImageSize();
    if (/^\d+x\d+$/i.test(raw)) return raw;
    if (/^\d+:\d+$/.test(raw)) return pickOpenAiImageSize(raw);
    // "1K" / "2K" / "auto" / 其它 Gemini 风格 → 用默认 1024x1024，避免上游 400。
    return pickOpenAiImageSize();
  }

  /**
   * 🔧 NEW (2026-05 #12): 仅放行已知可被 OpenAI/兼容上游识别的 quality 值。
   *   gpt-image-2 等模型对未声明的 quality 直接 400；多数自建中转把 quality
   *   忽略但少数会报 "unknown parameter"。统一在这里过滤，避免风险参数。
   */
  private sanitizeQuality(input?: string): string | undefined {
    const raw = (input || '').trim().toLowerCase();
    if (!raw) return undefined;
    if (raw === 'standard' || raw === 'hd' || raw === 'high' || raw === 'low' || raw === 'medium') {
      return raw;
    }
    return undefined;
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `proxy-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get usage statistics
   */
  getUsageStatistics(userId?: string, serviceId?: string): {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    averageResponseTime: number;
    recentRequests: UsageRecord[];
    dailyStats?: { date: string; requests: number; }[];
    errorRate: number;
    activeRequests: number;
  } {
    let filteredRecords = this.usageRecords;

    if (userId) {
      filteredRecords = filteredRecords.filter(r => r.userId === userId);
    }

    if (serviceId) {
      filteredRecords = filteredRecords.filter(r => r.serviceId === serviceId);
    }

    const totalRequests = filteredRecords.length;
    const successfulRequests = filteredRecords.filter(r => r.success).length;
    const failedRequests = totalRequests - successfulRequests;
    
    const totalResponseTime = filteredRecords.reduce((sum, r) => sum + r.responseTime, 0);
    const averageResponseTime = totalRequests > 0 ? totalResponseTime / totalRequests : 0;
    const errorRate = totalRequests > 0 ? (failedRequests / totalRequests) * 100 : 0;

    // Get daily statistics
    const dailyStats: { date: string; requests: number; }[] = [];
    const today = new Date().toISOString().split('T')[0];
    
    if (userId) {
      const userDailyKey = `${userId}-${today}`;
      const userStats = this.dailyUsageStats.get(userDailyKey);
      if (userStats) {
        dailyStats.push(userStats);
      }
    }
    
    if (serviceId) {
      const serviceDailyKey = `${serviceId}-${today}`;
      const serviceStats = this.dailyUsageStats.get(serviceDailyKey);
      if (serviceStats) {
        dailyStats.push(serviceStats);
      }
    }

    return {
      totalRequests,
      successfulRequests,
      failedRequests,
      averageResponseTime,
      recentRequests: filteredRecords.slice(-10), // Last 10 requests
      dailyStats: dailyStats.length > 0 ? dailyStats : undefined,
      errorRate,
      activeRequests: this.activeRequests.size
    };
  }

  /**
   * Cancel all active requests for a user
   */
  cancelUserRequests(userId: string): number {
    let cancelledCount = 0;
    
    for (const [requestId, controller] of this.activeRequests.entries()) {
      // In a real implementation, we'd need to track which requests belong to which user
      // For now, we'll cancel all requests (this is a simplified implementation)
      controller.abort();
      this.activeRequests.delete(requestId);
      cancelledCount++;
    }

    console.log(`Cancelled ${cancelledCount} active requests`);
    return cancelledCount;
  }

  /**
   * Get active request count
   */
  getActiveRequestCount(userId?: string): number {
    // In a real implementation, we'd filter by userId
    return this.activeRequests.size;
  }

  /**
   * Clear usage records
   */
  clearUsageRecords(): void {
    this.usageRecords = [];
  }

  /**
   * Validate service configuration for proxying
   */
  async validateServiceForProxying(serviceId: string): Promise<{
    isValid: boolean;
    reason?: string;
    config?: BuiltInServiceConfig;
  }> {
    try {
      const config = await this.configManager.getBuiltInServiceConfig(serviceId);
      
      if (!config) {
        return { isValid: false, reason: 'Service configuration not found' };
      }

      if (!config.isEnabled) {
        return { isValid: false, reason: 'Service is disabled', config };
      }

      if (!config.apiKey) {
        return { isValid: false, reason: 'API key not configured', config };
      }

      const isAvailable = await this.configManager.isServiceAvailable(serviceId);
      if (!isAvailable) {
        return { isValid: false, reason: 'Service is not available', config };
      }

      return { isValid: true, config };
    } catch (error) {
      console.error(`Error validating service for proxying: ${serviceId}`, error);
      return { 
        isValid: false, 
        reason: `Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}` 
      };
    }
  }

  /**
   * Get comprehensive system statistics
   */
  getSystemStatistics(): {
    totalUsers: number;
    totalServices: number;
    totalRequests: number;
    successRate: number;
    averageResponseTime: number;
    activeRequests: number;
    topUsers: { userId: string; requests: number; }[];
    topServices: { serviceId: string; requests: number; }[];
    recentErrors: UsageRecord[];
  } {
    const totalRequests = this.usageRecords.length;
    const successfulRequests = this.usageRecords.filter(r => r.success).length;
    const successRate = totalRequests > 0 ? (successfulRequests / totalRequests) * 100 : 0;
    
    const totalResponseTime = this.usageRecords.reduce((sum, r) => sum + r.responseTime, 0);
    const averageResponseTime = totalRequests > 0 ? totalResponseTime / totalRequests : 0;

    // Get unique users and services
    const uniqueUsers = new Set(this.usageRecords.map(r => r.userId));
    const uniqueServices = new Set(this.usageRecords.map(r => r.serviceId));

    // Get top users by request count
    const userCounts = new Map<string, number>();
    this.usageRecords.forEach(r => {
      userCounts.set(r.userId, (userCounts.get(r.userId) || 0) + 1);
    });
    const topUsers = Array.from(userCounts.entries())
      .map(([userId, requests]) => ({ userId, requests }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 5);

    // Get top services by request count
    const serviceCounts = new Map<string, number>();
    this.usageRecords.forEach(r => {
      serviceCounts.set(r.serviceId, (serviceCounts.get(r.serviceId) || 0) + 1);
    });
    const topServices = Array.from(serviceCounts.entries())
      .map(([serviceId, requests]) => ({ serviceId, requests }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 5);

    // Get recent errors
    const recentErrors = this.usageRecords
      .filter(r => !r.success)
      .slice(-10);

    return {
      totalUsers: uniqueUsers.size,
      totalServices: uniqueServices.size,
      totalRequests,
      successRate,
      averageResponseTime,
      activeRequests: this.activeRequests.size,
      topUsers,
      topServices,
      recentErrors
    };
  }

  /**
   * Get user quota usage
   * 🔧 UPDATED: Now reads from database for persistent tracking
   */
  async getUserQuotaUsage(userId: string): Promise<{
    dailyRequests: number;
    monthlyRequests: number;
    remainingDaily: number;
    remainingMonthly: number;
  }> {
    try {
      // Try to get usage from database first
      const { getUserUsageStats } = await import('../db');
      const dbStats = await getUserUsageStats(userId);
      
      // Get quota limits from user permissions
      let dailyLimit = 500; // Default
      let monthlyLimit = 15000; // Default
      
      try {
        const users = await this.authVerifier.getAuthorizedUsers();
        const normalized = userId.trim().toLowerCase();
        const user = users.find((u) => {
          const matchUserId = (u.userId || "").trim().toLowerCase() === normalized;
          const matchEmail = (u.email || "").trim().toLowerCase() === normalized;
          return matchUserId || matchEmail;
        });
        if (user && user.permissions?.quotaLimits) {
          dailyLimit = user.permissions.quotaLimits.dailyRequests || dailyLimit;
          monthlyLimit = user.permissions.quotaLimits.monthlyRequests || monthlyLimit;
        }
      } catch (error) {
        console.warn('Failed to get user quota limits, using defaults:', error);
      }

      return {
        dailyRequests: dbStats.dailyUsage,
        monthlyRequests: dbStats.monthlyUsage,
        remainingDaily: Math.max(0, dailyLimit - dbStats.dailyUsage),
        remainingMonthly: Math.max(0, monthlyLimit - dbStats.monthlyUsage)
      };
    } catch (error) {
      console.error('Failed to get usage from database, falling back to memory:', error);
      
      // Fallback to memory-based tracking
      const userRecords = this.usageRecords.filter(r => r.userId === userId);
      
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);

      const dailyRequests = userRecords.filter(r => r.timestamp >= today).length;
      const monthlyRequests = userRecords.filter(r => r.timestamp >= thisMonth).length;
      
      const dailyLimit = 500;
      const monthlyLimit = 15000;

      return {
        dailyRequests,
        monthlyRequests,
        remainingDaily: Math.max(0, dailyLimit - dailyRequests),
        remainingMonthly: Math.max(0, monthlyLimit - monthlyRequests)
      };
    }
  }

  /**
   * Get performance monitoring data
   */
  getPerformanceData(): any {
    return {
      realTimeMetrics: this.performanceMonitor.getRealTimeMetrics(),
      performanceStatistics: this.performanceMonitor.getPerformanceStatistics(),
      systemHealthStatus: this.performanceMonitor.getSystemHealthStatus(),
      optimizerMetrics: this.performanceOptimizer.getPerformanceMetrics(),
      cacheStatistics: this.performanceOptimizer.getCacheStatistics(),
      securityStatistics: this.securityEnhancer.getSecurityStatistics()
    };
  }

  /**
   * Get security statistics
   */
  getSecurityStatistics(): any {
    return this.securityEnhancer.getSecurityStatistics();
  }

  /**
   * Block a user for security reasons
   */
  blockUser(userId: string, reason: string): void {
    this.securityEnhancer.temporarilyBlockUser(userId, reason);
    console.log(`🚫 User ${userId} blocked: ${reason}`);
  }

  /**
   * Block an IP address
   */
  blockIP(ipAddress: string, reason: string): void {
    this.securityEnhancer.blockIP(ipAddress, reason);
    console.log(`🚫 IP ${ipAddress} blocked: ${reason}`);
  }

  /**
   * Update security configuration
   */
  updateSecurityConfig(config: any): void {
    this.securityEnhancer.updateConfig(config);
    console.log('Security configuration updated');
  }

  /**
   * Batch process multiple image generation requests
   */
  async batchProxyImageGeneration(requests: ProxyImageRequest[]): Promise<any[]> {
    console.log(`🔄 Processing batch of ${requests.length} image generation requests`);
    
    return this.performanceOptimizer.batchRequests(
      requests,
      (request: ProxyImageRequest) => this.proxyImageGeneration(request),
      3 // Batch size of 3 to avoid overwhelming the service
    );
  }

  /**
   * Warm up cache with common requests
   */
  async warmUpCache(commonRequests: ProxyImageRequest[]): Promise<void> {
    console.log(`🔥 Warming up cache with ${commonRequests.length} common requests`);
    
    await this.performanceOptimizer.warmUpCache(
      commonRequests,
      (request: ProxyImageRequest) => this.proxyImageGeneration(request)
    );
  }

  /**
   * Optimize performance based on usage patterns
   */
  optimizePerformance(): void {
    console.log('🎯 Optimizing API proxy performance...');
    
    // Optimize cache
    this.performanceOptimizer.optimizeCache();
    
    // Clean up old usage records
    this.cleanupOldRecords();
    
    // Log optimization results
    const metrics = this.performanceOptimizer.getPerformanceMetrics();
    console.log('Performance optimization completed:', {
      cacheHitRate: `${metrics.cacheHitRate.toFixed(1)}%`,
      averageResponseTime: `${metrics.averageResponseTime.toFixed(0)}ms`,
      activeConnections: metrics.activeConnections,
      errorRate: `${metrics.errorRate.toFixed(1)}%`
    });
  }

  /**
   * Export usage data for analytics
   */
  exportUsageData(startDate?: Date, endDate?: Date): UsageRecord[] {
    let records = this.usageRecords;

    if (startDate) {
      records = records.filter(r => r.timestamp >= startDate);
    }

    if (endDate) {
      records = records.filter(r => r.timestamp <= endDate);
    }

    return records.map(r => ({
      ...r,
      // Remove sensitive data for export
      requestId: r.requestId.replace(/proxy-\d+-/, 'proxy-***-')
    }));
  }
}
