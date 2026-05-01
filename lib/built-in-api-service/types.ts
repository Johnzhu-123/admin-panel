/**
 * Built-in API Service Types
 * Core type definitions for the built-in API service system
 * Validates: Requirements 2.4, 3.4, 4.1
 */

export interface BuiltInServiceConfig {
  id: string;
  name: string;
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  isEnabled: boolean;
  quotaLimits: QuotaLimits;
  rateLimits: RateLimitConfig;
  createdAt: Date;
  updatedAt: Date;
}

export interface QuotaLimits {
  dailyRequests: number;
  monthlyRequests: number;
  concurrentRequests: number;
}

export interface RateLimitConfig {
  requestsPerMinute: number;
  requestsPerHour: number;
  burstLimit: number;
}

export interface UserPermissions {
  canUseBuiltInServices: boolean;
  allowedServices: string[];
  quotaLimits: QuotaLimits;
  grantedAt: Date;
  grantedBy: string;
}

export interface AuthorizedUser {
  userId: string;
  email?: string;
  name?: string;
  permissions: UserPermissions;
  status: 'active' | 'suspended' | 'expired';
}

export interface AuthorizationResult {
  isAuthorized: boolean;
  permissions: string[];
  expiresAt?: Date;
  reason?: string;
}

export interface ServiceOption {
  id: string;
  name: string;
  description: string;
  provider: string;
  isBuiltIn: boolean;
  isAvailable: boolean;
}

export interface SwitchResult {
  success: boolean;
  serviceId: string;
  message: string;
  error?: string;
}

export interface ServiceStatus {
  isUsingBuiltIn: boolean;
  currentService: ServiceOption;
  lastSwitched: Date;
}

export interface UserServiceConfig {
  userId: string;
  currentServiceType: 'built-in' | 'custom';
  builtInServiceId?: string;
  customConfig?: CustomAPIConfig;
  preferences: ServicePreferences;
  createdAt: Date;
  updatedAt: Date;
}

export interface ServicePreferences {
  autoSwitchToBuiltIn: boolean;
  preferredModel: string;
  defaultSize: string;
  defaultQuality: string;
}

export interface CustomAPIConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  authType: 'bearer' | 'api_key' | 'custom_header';
  customHeaders?: Record<string, string>;
}

export interface ServiceUsageStats {
  userId: string;
  serviceId: string;
  date: Date;
  requestCount: number;
  successCount: number;
  failureCount: number;
  totalResponseTime: number;
  averageResponseTime: number;
  quotaUsed: number;
  quotaRemaining: number;
}

export interface SystemUsageStats {
  date: Date;
  totalUsers: number;
  activeUsers: number;
  totalRequests: number;
  builtInServiceRequests: number;
  customServiceRequests: number;
  averageResponseTime: number;
  errorRate: number;
}

export interface PermissionConfig {
  version: string;
  lastUpdated: Date;
  authorizedUsers: AuthorizedUser[];
  defaultPermissions: UserPermissions;
  serviceConfigs: BuiltInServiceConfig[];
}

export interface ProxyImageRequest {
  userId: string;
  serviceId: string;
  prompt: string;
  model?: string;
  size?: string;
  quality?: string;
  response_format?: string;
  n?: number;
}

export interface UsageRecord {
  requestId: string;
  userId: string;
  serviceId: string;
  timestamp: Date;
  success: boolean;
  responseTime: number;
  error?: string;
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

export interface ImportResult {
  success: boolean;
  imported: number;
  failed: number;
  errors: string[];
}

// Error types for built-in API service
export class BuiltInServiceError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: any
  ) {
    super(message);
    this.name = 'BuiltInServiceError';
  }
}

export const BuiltInServiceErrorCodes = {
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  INVALID_CONFIG: 'INVALID_CONFIG',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  SERVICE_NOT_FOUND: 'SERVICE_NOT_FOUND',
  PROXY_ERROR: 'PROXY_ERROR',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED'
} as const;

export type BuiltInServiceErrorCode = typeof BuiltInServiceErrorCodes[keyof typeof BuiltInServiceErrorCodes];

// Error Recovery and Fallback Types
export interface ErrorRecoveryStrategy {
  recover(error: BuiltInServiceError, context: ServiceContext): Promise<RecoveryResult>;
  fallbackToCustomAPI(userId: string, originalRequest: any): Promise<FallbackResult>;
  checkServiceHealth(serviceId: string): Promise<HealthStatus>;
}

export interface ServiceContext {
  userId: string;
  serviceId: string;
  originalRequest?: any;
  attemptCount?: number;
}

export interface RecoveryResult {
  success: boolean;
  action: 'retry' | 'fallback' | 'fail';
  message: string;
  nextService?: string;
  retryAfter?: number; // seconds
}

export interface FallbackResult {
  success: boolean;
  message: string;
  newServiceId: string;
  requiresUserAction: boolean;
  actionRequired?: 'configure_custom_api' | 'manual_configuration' | 'contact_support';
  fallbackInstructions?: string[];
}

export interface HealthStatus {
  isHealthy: boolean;
  lastChecked: Date;
  consecutiveFailures: number;
  nextCheckTime: Date;
  error?: string;
  responseTime?: number;
}

export interface ErrorRecoveryStats {
  totalRecoveryAttempts: number;
  activeRecoveries: number;
  recentFailures: Array<{
    userId: string;
    serviceId: string;
    attempts: number;
    lastAttempt: Date;
  }>;
}

// Service Health Monitoring Types
export interface ServiceHealthMetrics {
  serviceId: string;
  isHealthy: boolean;
  uptime: number; // percentage
  averageResponseTime: number;
  errorRate: number;
  lastFailure?: Date;
  consecutiveFailures: number;
}

export interface SystemHealthSummary {
  overallHealth: 'healthy' | 'degraded' | 'unhealthy';
  totalServices: number;
  healthyServices: number;
  degradedServices: number;
  unhealthyServices: number;
  services: ServiceHealthMetrics[];
  lastUpdated: Date;
}