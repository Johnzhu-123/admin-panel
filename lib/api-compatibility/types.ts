// Core types for the API compatibility system

export type AuthenticationType = 'bearer' | 'api_key' | 'custom_header';

export type ErrorType = 
  | 'path_error'
  | 'auth_error' 
  | 'format_error'
  | 'network_error'
  | 'content_policy'
  | 'rate_limit'
  | 'timeout_error'
  | 'response_format_error'
  | 'api_error'
  | 'unknown';

export type NetworkErrorType = 'TLS' | 'DNS' | 'PORT' | 'TIMEOUT' | 'CONNECTION';

export interface APIProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  authType: AuthenticationType;
  customHeaders?: Record<string, string>;
}

export interface ImageGenerationRequest {
  prompt: string;
  model?: string;
  size?: string;
  quality?: string;
  response_format?: string;
  n?: number;
}

export interface ImageData {
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
}

export interface UsageInfo {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ErrorInfo {
  code?: string;
  message: string;
  type?: string;
  param?: string;
}

export interface ImageGenerationResponse {
  images: ImageData[];
  usage?: UsageInfo;
  error?: ErrorInfo;
}

export interface ValidationResult {
  isValid: boolean;
  issues: string[];
  suggestedFix?: string;
}

export interface HTTPRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: any;
}

export interface CertificateInfo {
  valid: boolean;
  issuer?: string;
  subject?: string;
  validFrom?: Date;
  validTo?: Date;
  errors?: string[];
}

export interface DNSResult {
  resolved: boolean;
  addresses?: string[];
  error?: string;
}

export interface NetworkError {
  type: NetworkErrorType;
  message: string;
  details?: any;
}

export interface DiagnosticResult {
  success: boolean;
  latency: number;
  errors: NetworkError[];
  suggestions: string[];
}

export interface APIError {
  type: ErrorType;
  code: string;
  message: string;
  provider: string;
  timestamp: Date;
  request: any;
  response?: any;
  networkInfo?: NetworkError;
}

export class APIErrorImpl implements APIError {
  constructor(
    public type: ErrorType,
    public code: string,
    public message: string,
    public provider: string,
    public timestamp: Date,
    public request: any,
    public response?: any,
    public networkInfo?: NetworkError
  ) {}
}

export interface RecoveryAttempt {
  strategy: string;
  timestamp: Date;
  success: boolean;
  error?: string;
}

export interface FallbackResult {
  success: boolean;
  result?: ImageGenerationResponse;
  fallbackUsed: string;
  originalError: APIError;
}

export interface FallbackOption {
  id: string;
  name: string;
  description: string;
  priority: number;
  canHandle: (error: APIError) => boolean;
}

export interface RetryConfig {
  maxRetries: number;
  backoffMs: number;
  retryableErrors: string[];
}

export interface RateLimitConfig {
  requestsPerMinute: number;
  requestsPerHour: number;
  burstLimit: number;
}

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  authType: AuthenticationType;
  supportedFormats: string[];
  pathMappings: Record<string, string>;
  customHeaders: Record<string, string>;
  retryConfig: RetryConfig;
  timeoutMs: number;
  rateLimits: RateLimitConfig;
  // Extended properties for advanced compatibility
  parameterMapping?: {
    mapImageRequest?: (request: ImageGenerationRequest) => any;
  };
  responseAdapter?: {
    extractImageFromChat?: (response: any) => string;
    normalizeResponse?: (response: any) => ImageGenerationResponse;
  };
  errorHandling?: {
    handleError?: (error: any, response?: any) => {
      canRetry: boolean;
      userMessage: string;
      technicalDetails: string;
      suggestions: string[];
    };
  };
}

export interface PathCompatibility {
  supportsStandardPaths: boolean;
  requiresV1Prefix: boolean;
  customEndpoints: Record<string, string>;
}

export interface AuthCompatibility {
  supportedTypes: AuthenticationType[];
  requiredHeaders: string[];
  customAuthFlow: boolean;
}

export interface FormatCompatibility {
  supportedRequestFormats: string[];
  supportedResponseFormats: string[];
  defaultFormat: string;
}

export interface NetworkCompatibility {
  tlsSupported: boolean;
  portAccessible: boolean;
  dnsResolvable: boolean;
  latency: number;
}

export interface PolicyCompatibility {
  hasContentPolicy: boolean;
  strictness: 'low' | 'medium' | 'high';
  commonRestrictions: string[];
}

export interface CompatibilityProfile {
  providerId: string;
  detectedAt: Date;
  pathNormalization: PathCompatibility;
  authentication: AuthCompatibility;
  responseFormat: FormatCompatibility;
  networkStatus: NetworkCompatibility;
  contentPolicy: PolicyCompatibility;
}

export interface ErrorAnalytics {
  totalErrors: number;
  errorsByType: Record<ErrorType, number>;
  errorsByProvider: Record<string, number>;
  successRate: number;
  averageLatency: number;
  lastUpdated: Date;
}

export interface RequestContext {
  provider: APIProvider;
  request: ImageGenerationRequest;
  startTime: Date;
  attemptCount: number;
  previousErrors: APIError[];
  userId?: string; // 🔧 NEW: 用于请求队列去重和统计
}