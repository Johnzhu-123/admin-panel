// Core interfaces for the API compatibility system

import {
  APIProvider,
  ImageGenerationRequest,
  ImageGenerationResponse,
  CompatibilityProfile,
  ProviderConfig,
  ValidationResult,
  HTTPRequest,
  AuthenticationType,
  DiagnosticResult,
  CertificateInfo,
  DNSResult,
  FallbackResult,
  FallbackOption,
  APIError,
  RequestContext,
  RecoveryAttempt,
  ErrorAnalytics
} from './types';

export interface APICompatibilityManager {
  // Main API call interface
  generateImage(request: ImageGenerationRequest, provider: APIProvider): Promise<ImageGenerationResponse>;
  
  // Compatibility detection
  detectCompatibility(provider: APIProvider): Promise<CompatibilityProfile>;
  
  // Configuration management
  updateProviderConfig(providerId: string, config: ProviderConfig): void;
  getProviderConfig(providerId: string): ProviderConfig;
}

export interface PathNormalizer {
  // Path normalization
  normalizePath(baseUrl: string, endpoint: string): string;
  
  // Detect duplicate paths
  detectDuplicatePaths(url: string): boolean;
  
  // Validate URL validity
  validateUrl(url: string): ValidationResult;
}

export interface AuthenticationHandler {
  // Apply authentication
  applyAuthentication(request: HTTPRequest, provider: APIProvider): HTTPRequest;
  
  // Detect authentication type
  detectAuthType(provider: APIProvider): Promise<AuthenticationType>;
  
  // Validate authentication
  validateAuthentication(provider: APIProvider): Promise<boolean>;
}

export interface ResponseFormatAdapter {
  // Adapt request format
  adaptRequestFormat(request: ImageGenerationRequest, provider: APIProvider): ImageGenerationRequest;
  
  // Adapt response format
  adaptResponseFormat(response: any, provider: APIProvider): ImageGenerationResponse;
  
  // Detect supported formats
  detectSupportedFormats(provider: APIProvider): Promise<string[]>;
}

export interface NetworkDiagnostics {
  // Execute connection test
  testConnection(provider: APIProvider): Promise<DiagnosticResult>;
  
  // TLS certificate check
  checkTLSCertificate(url: string): Promise<CertificateInfo>;
  
  // Port reachability test
  testPortReachability(host: string, port: number): Promise<boolean>;
  
  // DNS resolution test
  testDNSResolution(hostname: string): Promise<DNSResult>;
}

export interface FallbackHandler {
  canHandle(error: APIError): boolean;
  execute(request: ImageGenerationRequest, error: APIError): Promise<FallbackResult>;
}

export interface FallbackStrategy {
  // Execute fallback strategy
  executeFallback(originalRequest: ImageGenerationRequest, error: APIError): Promise<FallbackResult>;
  
  // Register fallback handler
  registerFallbackHandler(errorType: string, handler: FallbackHandler): void;
  
  // Get fallback options
  getFallbackOptions(provider: APIProvider): FallbackOption[];
}

export interface ErrorRecoveryStrategy {
  // Error recovery flow
  recover(error: APIError, context: RequestContext): Promise<RecoveryResult>;
  
  // Retry strategy
  shouldRetry(error: APIError, attemptCount: number): boolean;
  
  // Fallback decision
  shouldFallback(error: APIError, recoveryAttempts: RecoveryAttempt[]): boolean;
}

export interface RecoveryResult {
  success: boolean;
  result?: ImageGenerationResponse;
  strategy: string;
  nextAction: 'retry' | 'fallback' | 'fail';
}

export interface ConfigurationManager {
  // Get provider configuration
  getProviderConfig(providerId: string): ProviderConfig | null;
  
  // Set provider configuration
  setProviderConfig(config: ProviderConfig): void;
  
  // Get predefined templates
  getProviderTemplate(providerName: string): ProviderConfig | null;
  
  // Auto-detect configuration
  autoDetectConfig(provider: APIProvider): Promise<ProviderConfig>;
  
  // List available templates
  listProviderTemplates(): string[];
}

export interface ErrorMonitor {
  // Record API error
  recordError(error: APIError): void;
  
  // Get error analytics
  getAnalytics(): ErrorAnalytics;
  
  // Get errors by type
  getErrorsByType(errorType: string): APIError[];
  
  // Get errors by provider
  getErrorsByProvider(providerId: string): APIError[];
  
  // Clear error history
  clearErrors(): void;
  
  // Export error logs
  exportErrorLogs(): string;
}