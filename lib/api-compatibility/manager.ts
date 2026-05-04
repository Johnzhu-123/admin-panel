// API Compatibility Manager - Core orchestrator for third-party API compatibility
// Validates: Requirements 2.1, 2.3, 2.4, 10.1, 10.4

import {
  APICompatibilityManager as IAPICompatibilityManager,
  PathNormalizer,
  AuthenticationHandler,
  ResponseFormatAdapter,
  NetworkDiagnostics,
  FallbackStrategy,
  ConfigurationManager,
  ErrorMonitor
} from './interfaces';

import {
  APIProvider,
  ImageGenerationRequest,
  ImageGenerationResponse,
  CompatibilityProfile,
  ProviderConfig,
  APIError,
  APIErrorImpl,
  ErrorType,
  RequestContext,
  AuthenticationType
} from './types';

import { PathNormalizer as PathNormalizerImpl } from './components/path-normalizer';
import { AuthenticationHandler as AuthHandlerImpl } from './components/auth-handler';
import { ResponseFormatAdapter as ResponseAdapterImpl } from './components/response-format-adapter';
import { NetworkDiagnostics as NetworkDiagnosticsImpl } from './components/network-diagnostics';
import { FallbackStrategyImpl } from './components/fallback-strategy';
import { ConfigurationManagerImpl } from './components/configuration-manager';
import { ErrorMonitorImpl } from './components/error-monitor';
import { 
  geminiBusiness2ApiConfig, 
  isGeminiBusiness2Api 
} from './providers/gemini-business2api';
import { ContentPolicyHandler } from './components/content-policy-handler';
import { queuedFetch } from '../request-queue-manager'; // 🔧 NEW: 导入请求队列管理器

export class APICompatibilityManager implements IAPICompatibilityManager {
  private pathNormalizer: PathNormalizer;
  private authHandler: AuthenticationHandler;
  private responseAdapter: ResponseFormatAdapter;
  private networkDiagnostics: NetworkDiagnostics;
  private fallbackStrategy: FallbackStrategy;
  private configManager: ConfigurationManager;
  private errorMonitor: ErrorMonitor;
  private contentPolicyHandler: ContentPolicyHandler;
  private configCache: Map<string, ProviderConfig> = new Map();
  private compatibilityCache: Map<string, CompatibilityProfile> = new Map();

  constructor() {
    this.pathNormalizer = new PathNormalizerImpl();
    this.authHandler = new AuthHandlerImpl();
    this.responseAdapter = new ResponseAdapterImpl();
    this.networkDiagnostics = new NetworkDiagnosticsImpl();
    this.fallbackStrategy = new FallbackStrategyImpl();
    this.configManager = new ConfigurationManagerImpl();
    this.errorMonitor = new ErrorMonitorImpl();
    this.contentPolicyHandler = new ContentPolicyHandler();
  }

  /**
   * Main image generation method with full compatibility handling
   * Validates: Requirements 2.1, 2.3, 2.4
   * 🔧 ENHANCED: 接受可选的context参数以支持userId传递
   */
  async generateImage(
    request: ImageGenerationRequest, 
    provider: APIProvider,
    contextOverride?: Partial<RequestContext>
  ): Promise<ImageGenerationResponse> {
    const startTime = new Date();
    const context: RequestContext = {
      provider,
      request,
      startTime,
      attemptCount: 0,
      previousErrors: [],
      ...contextOverride // 🔧 NEW: 合并传入的context（包括userId）
    };

    try {
      // Get or detect provider configuration
      let config = this.getProviderConfig(provider.id);
      if (!config) {
        config = await this.autoDetectAndCacheConfig(provider);
      }

      // Attempt image generation with compatibility handling
      return await this.attemptImageGeneration(request, provider, config, context);
    } catch (error) {
      // 🔧 FIX (2026-05 #13 root cause of "An unexpected error occurred" 第 2 层):
      //   旧实现一律调 createAPIError(error, ...) 重建 APIError，结果把
      //   handleAPIError 已经塞进去的 status/statusText/bodyPreview/data 全部丢失，
      //   message 也被覆盖成 "Unknown error occurred"（因为 createAPIError 默认值）。
      //   只要 attemptImageGeneration 抛出的本身就是 APIErrorImpl，就直接保留结构。
      const apiError = error instanceof APIErrorImpl
        ? error
        : this.createAPIError(error, provider, request, startTime);
      this.errorMonitor.recordError(apiError);

      // Try fallback strategies
      try {
        const fallbackResult = await this.fallbackStrategy.executeFallback(request, apiError);
        if (fallbackResult.success && fallbackResult.result) {
          return fallbackResult.result;
        }
      } catch (fallbackError) {
        // Log fallback failure but return original error
        console.warn('Fallback strategy failed:', fallbackError);
      }

      throw apiError;
    }
  }

  /**
   * Detects compatibility profile for a provider
   * Validates: Requirements 2.4, 10.1
   */
  async detectCompatibility(provider: APIProvider): Promise<CompatibilityProfile> {
    const cacheKey = `${provider.id}-${provider.baseUrl}`;
    
    // Check cache first
    if (this.compatibilityCache.has(cacheKey)) {
      const cached = this.compatibilityCache.get(cacheKey)!;
      // Return cached if less than 1 hour old
      if (Date.now() - cached.detectedAt.getTime() < 3600000) {
        return cached;
      }
    }

    try {
      // Run comprehensive compatibility detection
      const [networkStatus, authCompatibility, formatCompatibility] = await Promise.all([
        this.networkDiagnostics.testConnection(provider),
        this.detectAuthCompatibility(provider),
        this.detectFormatCompatibility(provider)
      ]);

      const profile: CompatibilityProfile = {
        providerId: provider.id,
        detectedAt: new Date(),
        pathNormalization: {
          supportsStandardPaths: !this.pathNormalizer.detectDuplicatePaths(provider.baseUrl),
          requiresV1Prefix: !provider.baseUrl.includes('/v1'),
          customEndpoints: {}
        },
        authentication: authCompatibility,
        responseFormat: formatCompatibility,
        networkStatus: {
          tlsSupported: networkStatus.success,
          portAccessible: networkStatus.success,
          dnsResolvable: networkStatus.success,
          latency: networkStatus.latency
        },
        contentPolicy: {
          hasContentPolicy: false, // Will be detected during actual usage
          strictness: 'medium',
          commonRestrictions: []
        }
      };

      // Cache the result
      this.compatibilityCache.set(cacheKey, profile);
      return profile;
    } catch (error) {
      // Return basic profile on detection failure
      return {
        providerId: provider.id,
        detectedAt: new Date(),
        pathNormalization: {
          supportsStandardPaths: false,
          requiresV1Prefix: true,
          customEndpoints: {}
        },
        authentication: {
          supportedTypes: ['bearer'],
          requiredHeaders: [],
          customAuthFlow: false
        },
        responseFormat: {
          supportedRequestFormats: ['b64_json', 'url'],
          supportedResponseFormats: ['b64_json', 'url'],
          defaultFormat: 'b64_json'
        },
        networkStatus: {
          tlsSupported: false,
          portAccessible: false,
          dnsResolvable: false,
          latency: 0
        },
        contentPolicy: {
          hasContentPolicy: true,
          strictness: 'high',
          commonRestrictions: ['unknown']
        }
      };
    }
  }

  /**
   * Updates provider configuration
   * Validates: Requirements 8.1, 8.4
   */
  updateProviderConfig(providerId: string, config: ProviderConfig): void {
    this.configManager.setProviderConfig(config);
    this.configCache.set(providerId, config);
    
    // Clear compatibility cache for this provider
    for (const [key] of this.compatibilityCache) {
      if (key.startsWith(`${providerId}-`)) {
        this.compatibilityCache.delete(key);
      }
    }
  }

  /**
   * Gets provider configuration
   * Validates: Requirements 8.1, 10.4
   */
  getProviderConfig(providerId: string): ProviderConfig {
    // Check cache first
    if (this.configCache.has(providerId)) {
      return this.configCache.get(providerId)!;
    }

    // Try configuration manager
    const config = this.configManager.getProviderConfig(providerId);
    if (config) {
      this.configCache.set(providerId, config);
      return config;
    }

    // Return default configuration
    const defaultConfig: ProviderConfig = {
      id: providerId,
      name: providerId,
      baseUrl: '',
      authType: 'bearer',
      supportedFormats: ['b64_json', 'url'],
      pathMappings: {},
      customHeaders: {},
      retryConfig: {
        maxRetries: 3,
        backoffMs: 1000,
        retryableErrors: ['network_error', 'rate_limit']
      },
      timeoutMs: 30000,
      rateLimits: {
        requestsPerMinute: 60,
        requestsPerHour: 1000,
        burstLimit: 10
      }
    };

    this.configCache.set(providerId, defaultConfig);
    return defaultConfig;
  }

  /**
   * Attempts image generation with full error handling and retries
   * Private method for core generation logic
   */
  private async attemptImageGeneration(
    request: ImageGenerationRequest,
    provider: APIProvider,
    config: ProviderConfig,
    context: RequestContext
  ): Promise<ImageGenerationResponse> {
    context.attemptCount++;

    // Special handling for Gemini Business2API
    if (isGeminiBusiness2Api(provider.baseUrl)) {
      return await this.handleGeminiBusiness2Api(request, provider, config, context);
    }

    // Normalize the endpoint URL
    const normalizedUrl = this.pathNormalizer.normalizePath(
      provider.baseUrl,
      '/images/generations'
    );

    // Prepare the request
    const adaptedRequest = this.responseAdapter.adaptRequestFormat(request, provider);
    
    // Create HTTP request
    const httpRequest = {
      url: normalizedUrl,
      method: 'POST',
      headers: {},
      body: adaptedRequest
    };

    // Apply authentication
    const authenticatedRequest = this.authHandler.applyAuthentication(httpRequest, provider);

    try {
      // 🔧 UPDATED: 使用队列化的fetch来避免429错误
      const response = await queuedFetch(
        authenticatedRequest.url,
        {
          method: authenticatedRequest.method,
          headers: authenticatedRequest.headers,
          body: JSON.stringify(authenticatedRequest.body),
          signal: AbortSignal.timeout(config.timeoutMs)
        },
        'normal', // priority
        context.userId // 用于去重和统计
      );

      const responseText = await response.text();
      let responseData: any;

      try {
        responseData = JSON.parse(responseText);
      } catch {
        responseData = { raw: responseText };
      }

      if (!response.ok) {
        // Handle specific error types
        const error = await this.handleAPIError(response, responseData, provider, request, context);
        throw error;
      }

      // Adapt the response format
      return this.responseAdapter.adaptResponseFormat(responseData, provider);
    } catch (error) {
      if (error instanceof APIErrorImpl) {
        throw error;
      }

      // Handle network and other errors
      const apiError = this.createAPIError(error, provider, request, context.startTime);
      
      // Check if we should retry
      if (this.shouldRetry(apiError, context)) {
        await this.sleep(config.retryConfig.backoffMs * context.attemptCount);
        return this.attemptImageGeneration(request, provider, config, context);
      }

      throw apiError;
    }
  }

  /**
   * Special handler for Gemini Business2API
   * Uses chat endpoint for image generation due to API design
   */
  private async handleGeminiBusiness2Api(
    request: ImageGenerationRequest,
    provider: APIProvider,
    config: ProviderConfig,
    context: RequestContext
  ): Promise<ImageGenerationResponse> {
    console.log('Handling Gemini Business2API request with extended timeout');
    
    // Use chat endpoint for image generation
    const chatUrl = this.pathNormalizer.normalizePath(
      provider.baseUrl,
      '/chat/completions'
    );

    // Create chat request for image generation
    const chatRequest = geminiBusiness2ApiConfig.parameterMapping!.mapImageRequest!(request);
    
    // Create HTTP request
    const httpRequest = {
      url: chatUrl,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: chatRequest
    };

    // Apply authentication
    const authenticatedRequest = this.authHandler.applyAuthentication(httpRequest, provider);

    try {
      // 🔧 UPDATED: 使用队列化的fetch来避免429错误
      const response = await queuedFetch(
        authenticatedRequest.url,
        {
          method: authenticatedRequest.method,
          headers: authenticatedRequest.headers,
          body: JSON.stringify(authenticatedRequest.body),
          signal: AbortSignal.timeout(300000) // 5 minutes for Gemini
        },
        'normal', // priority
        context.userId // 用于去重和统计
      );

      const responseText = await response.text();
      let responseData: any;

      try {
        responseData = JSON.parse(responseText);
      } catch {
        responseData = { raw: responseText };
      }

      console.log('Gemini Business2API response:', {
        status: response.status,
        hasChoices: !!responseData.choices,
        choicesLength: responseData.choices?.length || 0,
        contentSample: responseData.choices?.[0]?.message?.content?.substring(0, 200)
      });

      if (!response.ok) {
        // Handle Gemini Business2API specific errors
        const errorInfo = geminiBusiness2ApiConfig.errorHandling!.handleError!(
          { status: response.status, message: responseText },
          response
        );
        
        throw new APIErrorImpl(
          'api_error' as ErrorType,
          response.status.toString(),
          errorInfo.userMessage,
          provider.id,
          new Date(),
          request,
          response
        );
      }

      // Use specialized response adapter for Gemini Business2API
      const adaptedResponse = geminiBusiness2ApiConfig.responseAdapter!.normalizeResponse!(responseData);
      
      if (!adaptedResponse.images || adaptedResponse.images.length === 0) {
        throw new APIErrorImpl(
          'response_format_error' as ErrorType,
          '502',
          '未能从响应中提取图片数据',
          provider.id,
          new Date(),
          request
        );
      }

      return adaptedResponse;
    } catch (error) {
      if (error instanceof APIErrorImpl) {
        throw error;
      }

      // Handle timeout and network errors specifically for Gemini Business2API
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      if (errorMessage.includes('timeout') || errorMessage.includes('aborted')) {
        throw new APIErrorImpl(
          'timeout_error' as ErrorType,
          '408',
          'Gemini 图片生成超时，但可能已在后台完成。请检查后台日志或稍后重试。',
          provider.id,
          new Date(),
          request
        );
      }

      // Handle other errors
      const apiError = this.createAPIError(error, provider, request, context.startTime);
      
      // Check if we should retry
      if (this.shouldRetry(apiError, context) && context.attemptCount < 2) {
        await this.sleep(5000); // Wait 5 seconds before retry
        return this.handleGeminiBusiness2Api(request, provider, config, context);
      }

      throw apiError;
    }
  }

  /**
   * Handles API errors with intelligent error detection and recovery
   * Private method for error processing
   */
  private async handleAPIError(
    response: Response,
    responseData: any,
    provider: APIProvider,
    request: ImageGenerationRequest,
    context: RequestContext
  ): Promise<APIErrorImpl> {
    // 🔧 FIX (2026-05 #12 root cause of "An unexpected error occurred"):
    //   旧实现只调用 extractErrorMessage(responseData)，对没有标准 error 字段的
    //   上游响应（HTML 错误页、网关返回 plain text、502 短文本等）一律返回
    //   "Unknown error"，errorType 落到 'unknown'，再被 handleCompatibilityError
    //   的 default 分支替换成 "An unexpected error occurred"。链路上的真实状态码
    //   和响应体被三层吞掉，前端只能看到笼统提示。
    //   现在把 status/statusText/body preview 拼进 message，并在 response 字段里
    //   保留原始 raw 体，下游错误包装层 / route.ts 可以读取展示。
    const rawTextPreview = this.makeBodyPreview(responseData);
    const extracted = this.extractErrorMessage(responseData);
    const errorMessage = (extracted && extracted !== 'Unknown error')
      ? `${response.status} ${response.statusText || ''} | ${extracted}`.trim()
      : `${response.status} ${response.statusText || 'upstream error'} | body=${rawTextPreview || '(empty)'}`;
    const errorCode = this.extractErrorCode(responseData);
    
    // Detect error type
    let errorType: ErrorType = 'unknown';
    
    if (response.status === 401 || response.status === 403) {
      errorType = 'auth_error';
    } else if (response.status === 429) {
      errorType = 'rate_limit';
    } else if (response.status === 404) {
      errorType = 'path_error';
    } else if (this.isContentPolicyErrorFromResponse(responseData, errorMessage)) {
      errorType = 'content_policy';
      
      // Try to handle content policy error automatically
      try {
        const analysis = this.contentPolicyHandler.analyzeContentPolicyError(
          { type: errorType, code: errorCode, message: errorMessage, provider: provider.id, timestamp: new Date(), request: request },
          request
        );
        
        if (analysis.modifiedPrompt) {
          const safeRequest = { ...request, prompt: analysis.modifiedPrompt };
          
          // Retry with safe prompt
          const result = await this.attemptImageGeneration(safeRequest, provider, this.getProviderConfig(provider.id), {
            ...context,
            attemptCount: 0 // Reset attempt count for safe prompt retry
          });
          
          // If successful, return the result wrapped in a response
          return new APIErrorImpl(
            'content_policy' as ErrorType,
            'content_policy_resolved',
            `Content policy error resolved using safe prompt: "${analysis.modifiedPrompt}"`,
            provider.id,
            new Date(),
            request,
            result
          );
        }
      } catch (retryError) {
        // If retry fails, continue with original error
      }
    } else if (errorMessage.toLowerCase().includes('format') || errorMessage.toLowerCase().includes('response_format')) {
      errorType = 'format_error';
    }

    const apiError = new APIErrorImpl(
      errorType,
      errorCode,
      errorMessage,
      provider.id,
      new Date(),
      request,
      // 🔧 FIX (2026-05 #12 续): 保留 status / statusText / 上游原始响应数据 /
      //   body 预览，方便上层再次提取并展示给前端。
      {
        status: response.status,
        statusText: response.statusText,
        bodyPreview: rawTextPreview,
        data: responseData
      }
    );

    context.previousErrors.push(apiError);
    return apiError;
  }

  /**
   * Auto-detects and caches provider configuration
   * Private method for configuration management
   */
  private async autoDetectAndCacheConfig(provider: APIProvider): Promise<ProviderConfig> {
    try {
      const config = await this.configManager.autoDetectConfig(provider);
      this.configCache.set(provider.id, config);
      return config;
    } catch (error) {
      // Return default config on detection failure
      const defaultConfig = this.getProviderConfig(provider.id);
      defaultConfig.baseUrl = provider.baseUrl;
      return defaultConfig;
    }
  }

  /**
   * Detects authentication compatibility
   * Private helper method
   */
  private async detectAuthCompatibility(provider: APIProvider) {
    try {
      const detectedType = await this.authHandler.detectAuthType(provider);
      return {
        supportedTypes: [detectedType] as AuthenticationType[],
        requiredHeaders: [],
        customAuthFlow: detectedType === 'custom_header'
      };
    } catch {
      return {
        supportedTypes: ['bearer'] as AuthenticationType[],
        requiredHeaders: [],
        customAuthFlow: false
      };
    }
  }

  /**
   * Detects format compatibility
   * Private helper method
   */
  private async detectFormatCompatibility(provider: APIProvider) {
    try {
      const formats = await this.responseAdapter.detectSupportedFormats(provider);
      return {
        supportedRequestFormats: formats,
        supportedResponseFormats: formats,
        defaultFormat: formats[0] || 'b64_json'
      };
    } catch {
      return {
        supportedRequestFormats: ['b64_json', 'url'],
        supportedResponseFormats: ['b64_json', 'url'],
        defaultFormat: 'b64_json'
      };
    }
  }

  /**
   * Determines if an error should trigger a retry
   * Private helper method
   */
  private shouldRetry(error: APIError, context: RequestContext): boolean {
    const config = this.getProviderConfig(context.provider.id);
    
    if (context.attemptCount >= config.retryConfig.maxRetries) {
      return false;
    }

    return config.retryConfig.retryableErrors.includes(error.type);
  }

  /**
   * Creates an APIError from various error types
   * Private helper method
   */
  private createAPIError(
    error: any,
    provider: APIProvider,
    request: ImageGenerationRequest,
    startTime: Date
  ): APIError {
    // 🔧 FIX (2026-05 #13): 防御式：如果传进来的就已经是结构化 APIError-like 对象
    //   （有 type/code/message 三件套，或来自 handleAPIError 的旧 plain 对象），
    //   直接保留，避免被 createAPIError 的默认值覆盖成 "Unknown error occurred"。
    if (error && typeof error === 'object'
        && typeof error.type === 'string'
        && typeof error.message === 'string') {
      return error as APIError;
    }

    // 🔧 NEW (2026-05 #15): 把 createAPIError 实际收到的 error 对象 dump 到日志，
    //   便于在 Render 上排查为什么 "An unexpected error occurred" 还在出现。
    try {
      const dump: any = {
        v: 'v15',
        provider: provider?.id,
        ctor: error?.constructor?.name,
        name: error?.name,
        msg: typeof error?.message === 'string' ? error.message.slice(0, 200) : null,
        msgEmpty: typeof error?.message === 'string' && error.message === '',
        isError: error instanceof Error,
        keys: error && typeof error === 'object' ? Object.keys(error).slice(0, 12) : null,
        causeCtor: (error as any)?.cause?.constructor?.name,
        causeMsg: typeof (error as any)?.cause?.message === 'string'
          ? (error as any).cause.message.slice(0, 200)
          : null,
        causeCode: (error as any)?.cause?.code,
        stackHead: typeof error?.stack === 'string' ? error.stack.slice(0, 240) : null
      };
      console.error('[createAPIError v15] received error dump:', JSON.stringify(dump));
    } catch (logErr) {
      console.error('[createAPIError v15] failed to dump error:', logErr);
    }

    let errorType: ErrorType = 'unknown';
    let message = 'Unknown error occurred';
    let code = 'unknown';

    // 🔧 FIX (2026-05 #15): 不再依赖 instanceof Error（undici 在 worker 边界经常
    //   把 error 抹成 plain object）。改成 duck typing：只要有可读的 message/cause
    //   就尽量提取。
    const errMessage = typeof error?.message === 'string' ? error.message : '';
    if (errMessage) {
      message = errMessage;
    }
    // undici / fetch 失败时真实 reason 在 error.cause 上，拼到 message。
    const cause: any = (error as any)?.cause;
    if (cause && typeof cause === 'object') {
      const causeMsg = typeof cause.message === 'string' ? cause.message : '';
      const causeCode = typeof cause.code === 'string' ? cause.code : '';
      if (causeMsg || causeCode) {
        message = `${message} | cause=${[causeCode, causeMsg].filter(Boolean).join(' ')}`;
      }
    }
    // error.name 也有诊断价值（AbortError / TypeError / FetchError）
    const errName = typeof error?.name === 'string' ? error.name : '';
    if (errName && errName !== 'Error' && !message.includes(errName)) {
      message = `${errName}: ${message}`;
    }

    if (message.includes('timeout') || message.includes('UND_ERR_HEADERS_TIMEOUT')
        || message.includes('AbortError') || message.includes('aborted')) {
      errorType = 'network_error';
      code = 'timeout';
    } else if (message.includes('fetch') || message.includes('network')
               || message.includes('ECONNRESET') || message.includes('ENOTFOUND')
               || message.includes('UND_ERR_')) {
      errorType = 'network_error';
      code = 'network_error';
    }
    if (typeof error === 'string') {
      message = error;
    }

    // 🔧 FIX (2026-05 #16): 当上面所有 duck typing 都没能榨出真消息时（即仍是
    //   "Unknown error occurred" 默认值），把诊断 dump 直接拼进 message，让前端
    //   响应里就能看到原始 error 的形态，免去 Render 日志依赖。
    if (message === 'Unknown error occurred' && error) {
      try {
        const ctor = (error as any)?.constructor?.name;
        const eName = (error as any)?.name;
        const eType = (error as any)?.type;
        const eCode = (error as any)?.code;
        const isErr = error instanceof Error;
        const keys = (typeof error === 'object') ? Object.keys(error).slice(0, 8) : [];
        // 🔧 FIX (2026-05 #17): Object.keys 只看到可枚举属性，Error 的 message/name/stack
        //   都是不可枚举的，对真 Error 实例会返回 []。改用 getOwnPropertyNames 拿全部。
        const ownProps = (typeof error === 'object')
          ? Object.getOwnPropertyNames(error).slice(0, 12)
          : [];
        const causeCtor = (error as any)?.cause?.constructor?.name;
        const stackHead = typeof (error as any)?.stack === 'string'
          ? (error as any).stack.slice(0, 160).replace(/\n/g, ' ')
          : '';
        // 🔧 FIX (2026-05 #17): 拼一个 createAPIError 自己的调用栈，定位是哪个 catch 在调它
        const callerStack = new Error('createAPIError-invocation').stack || '';
        const callerLine = callerStack.split('\n').slice(2, 4).join(' ').slice(0, 200).replace(/\s+/g, ' ');
        const inlineDump = `[v17 dump] ctor=${ctor || '?'} name=${eName || '?'} type=${eType || '?'} code=${eCode || '?'} isErr=${isErr} keys=[${keys.join(',')}] ownProps=[${ownProps.join(',')}] causeCtor=${causeCtor || '?'} stack=${stackHead} caller=${callerLine}`;
        message = `${message} ${inlineDump}`;
      } catch {
        // 忽略 dump 失败本身
      }
    }

    // 🔧 FIX (2026-05 #16): 永远返回 APIErrorImpl 实例，让后续 instanceof 检查
    //   一致通过，避免上层重复包装丢失结构。
    return new APIErrorImpl(
      errorType,
      code,
      message,
      provider.id,
      new Date(),
      request,
      error  // 原始 error 放到 response 字段
    );
  }

  /**
   * Extracts error message from response data
   * Private helper method
   */
  private extractErrorMessage(data: any): string {
    if (typeof data?.error?.message === 'string') return data.error.message;
    if (typeof data?.error === 'string') return data.error;
    if (typeof data?.message === 'string') return data.message;
    if (typeof data?.detail === 'string') return data.detail;
    return 'Unknown error';
  }

  /**
   * 🔧 NEW (2026-05 #12): 生成上游响应体的可读预览，用来在 error.message 里
   *   保留诊断信息。优先用 raw 文本（HTML 错误页 / plain text），其次 JSON 序列化。
   *   截断到 240 字符以避免日志爆炸。
   */
  private makeBodyPreview(data: any): string {
    if (data == null) return '';
    if (typeof data === 'string') {
      return data.length > 240 ? `${data.slice(0, 240)}...` : data;
    }
    if (typeof data?.raw === 'string') {
      return data.raw.length > 240 ? `${data.raw.slice(0, 240)}...` : data.raw;
    }
    try {
      const s = JSON.stringify(data);
      return s.length > 240 ? `${s.slice(0, 240)}...` : s;
    } catch {
      return '[unserializable response]';
    }
  }

  /**
   * Extracts error code from response data
   * Private helper method
   */
  private extractErrorCode(data: any): string {
    if (typeof data?.error?.code === 'string') return data.error.code;
    if (typeof data?.error?.type === 'string') return data.error.type;
    if (typeof data?.code === 'string') return data.code;
    return 'unknown';
  }

  /**
   * Checks if response indicates a content policy error
   * Private helper method
   */
  private isContentPolicyErrorFromResponse(data: any, message: string): boolean {
    const errorMessage = message.toLowerCase();
    const contentPolicyKeywords = [
      'content policy',
      'policy violation',
      'inappropriate content',
      'content filter',
      'safety filter',
      'content blocked',
      'violates our usage policies',
      'against our content policy',
      'content guidelines',
      'safety guidelines',
      'safety system',
      'rejected as a result of our safety',
    ];

    return contentPolicyKeywords.some(keyword => errorMessage.includes(keyword));
  }

  /**
   * Sleep utility for retry delays
   * Private helper method
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Gets error analytics from the error monitor
   * Public method for monitoring
   */
  getErrorAnalytics() {
    return this.errorMonitor.getAnalytics();
  }

  /**
   * Clears all caches
   * Public method for cache management
   */
  clearCaches(): void {
    this.configCache.clear();
    this.compatibilityCache.clear();
  }
}