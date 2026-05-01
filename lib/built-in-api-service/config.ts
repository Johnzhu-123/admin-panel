/**
 * Built-in API Service Configuration
 * Configuration constants and defaults for the built-in API service system
 * Validates: Requirements 2.4, 3.4, 4.1
 */

import { BuiltInServiceConfig, UserPermissions, QuotaLimits, RateLimitConfig } from './types';

// Default quota limits for new users
export const DEFAULT_QUOTA_LIMITS: QuotaLimits = {
  dailyRequests: 50,
  monthlyRequests: 1000,
  concurrentRequests: 3
};

// Default rate limits for built-in services
export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  requestsPerMinute: 10,
  requestsPerHour: 100,
  burstLimit: 5
};

// Default user permissions for authorized users
export const DEFAULT_USER_PERMISSIONS: UserPermissions = {
  canUseBuiltInServices: true,
  allowedServices: ['gemini-built-in'],
  quotaLimits: DEFAULT_QUOTA_LIMITS,
  grantedAt: new Date(),
  grantedBy: 'system'
};

const parseEnvBoolean = (value: string | undefined, fallback = true) => {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
};

const normalizeBuiltInModel = (model: string | undefined) => {
  const raw = (model || "").trim();
  if (!raw) return "gemini-3-pro-preview";
  if (/gemini.*imagen/i.test(raw)) return "gemini-3-pro-preview";
  return raw;
};

// 使用合理的默认值，减少必需的环境变量
const builtInServiceName =
  process.env.BUILT_IN_SERVICE_NAME || '行云API';
const builtInServiceModel = normalizeBuiltInModel(
  process.env.BUILT_IN_SERVICE_MODEL
);
const builtInServiceEnabled = parseEnvBoolean(
  process.env.BUILT_IN_SERVICE_ENABLED,
  true  // 默认启用，只要配置了API密钥就可用
);

// Built-in service configurations
export const BUILT_IN_SERVICES: Record<string, Omit<BuiltInServiceConfig, 'apiKey'>> = {
  'gemini-built-in': {
    id: 'gemini-built-in',
    name: builtInServiceName,
    provider: 'gemini',
    // 使用实际的API URL作为默认值
    baseUrl: process.env.GEMINI_BUILT_IN_BASE_URL || 'https://seeyjys.zeabur.app/v1',
    model: builtInServiceModel,
    isEnabled: builtInServiceEnabled,
    quotaLimits: {
      dailyRequests: 10000,
      monthlyRequests: 100000,
      concurrentRequests: 50
    },
    rateLimits: DEFAULT_RATE_LIMITS,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date()
  }
};

// Configuration file paths
export const CONFIG_PATHS = {
  PERMISSIONS: '.kiro/built-in-api-service/permissions.json',
  SERVICES: '.kiro/built-in-api-service/services.json',
  USER_CONFIGS: '.kiro/built-in-api-service/user-configs/',
  USAGE_STATS: '.kiro/built-in-api-service/usage-stats/',
  BACKUPS: '.kiro/built-in-api-service/backups/'
} as const;

// Environment variable names for built-in service API keys
export const ENV_KEYS = {
  GEMINI_BUILT_IN_API_KEY: 'GEMINI_BUILT_IN_API_KEY',
  OPENAI_BUILT_IN_API_KEY: 'OPENAI_BUILT_IN_API_KEY',
  CLAUDE_BUILT_IN_API_KEY: 'CLAUDE_BUILT_IN_API_KEY'
} as const;

// Service availability check intervals (in milliseconds)
export const HEALTH_CHECK_INTERVALS = {
  FAST: 30000,    // 30 seconds
  NORMAL: 60000,  // 1 minute
  SLOW: 300000    // 5 minutes
} as const;

// Cache TTL values (in milliseconds)
export const CACHE_TTL = {
  PERMISSIONS: 300000,      // 5 minutes
  SERVICE_CONFIG: 600000,   // 10 minutes
  USER_CONFIG: 180000,      // 3 minutes
  HEALTH_STATUS: 60000      // 1 minute
} as const;

// Request timeout values (in milliseconds)
export const TIMEOUTS = {
  API_REQUEST: 30000,       // 30 seconds
  HEALTH_CHECK: 10000,      // 10 seconds
  CONFIG_LOAD: 5000         // 5 seconds
} as const;

// Error retry configuration
export const RETRY_CONFIG = {
  MAX_RETRIES: 3,
  INITIAL_DELAY: 1000,      // 1 second
  MAX_DELAY: 10000,         // 10 seconds
  BACKOFF_FACTOR: 2
} as const;

// Supported providers for built-in services
export const SUPPORTED_PROVIDERS = [
  'gemini',
  'openai',
  'claude'
] as const;

export type SupportedProvider = typeof SUPPORTED_PROVIDERS[number];

// Default models for each provider
export const DEFAULT_MODELS: Record<SupportedProvider, string> = {
  gemini: 'gemini-3-pro-preview',
  openai: 'dall-e-3',
  claude: 'claude-3-sonnet'
};

// Service priority order (higher number = higher priority)
export const SERVICE_PRIORITY: Record<string, number> = {
  'gemini-built-in': 100,
  'openai-built-in': 90,
  'claude-built-in': 80
};

// Feature flags for built-in API service
export const FEATURE_FLAGS = {
  ENABLE_USAGE_TRACKING: true,
  ENABLE_QUOTA_ENFORCEMENT: true,
  ENABLE_RATE_LIMITING: true,
  ENABLE_HEALTH_MONITORING: true,
  ENABLE_AUTO_FALLBACK: true,
  ENABLE_CACHING: true
} as const;

// Validation rules
export const VALIDATION_RULES = {
  MIN_USER_ID_LENGTH: 3,
  MAX_USER_ID_LENGTH: 100,
  MIN_SERVICE_NAME_LENGTH: 3,
  MAX_SERVICE_NAME_LENGTH: 50,
  MAX_PROMPT_LENGTH: 10000,
  MAX_API_KEY_LENGTH: 500
} as const;

// Security settings
export const SECURITY_SETTINGS = {
  API_KEY_MASK_LENGTH: 8,           // Show only last 8 characters
  SESSION_TIMEOUT: 3600000,         // 1 hour
  MAX_CONCURRENT_REQUESTS: 10,      // Per user
  RATE_LIMIT_WINDOW: 60000          // 1 minute
} as const;

/**
 * Get built-in service configuration with API key from environment
 */
export function getBuiltInServiceConfig(serviceId: string): BuiltInServiceConfig | null {
  const baseConfig = BUILT_IN_SERVICES[serviceId];
  if (!baseConfig) {
    return null;
  }

  // Get API key from environment
  let apiKey = '';
  switch (baseConfig.provider) {
    case 'gemini':
      apiKey = process.env[ENV_KEYS.GEMINI_BUILT_IN_API_KEY] || '';
      break;
    case 'openai':
      apiKey = process.env[ENV_KEYS.OPENAI_BUILT_IN_API_KEY] || '';
      break;
    case 'claude':
      apiKey = process.env[ENV_KEYS.CLAUDE_BUILT_IN_API_KEY] || '';
      break;
  }

  if (!apiKey) {
    console.warn(`No API key found for built-in service: ${serviceId}`);
    return null;
  }

  return {
    ...baseConfig,
    apiKey,
    updatedAt: new Date()
  };
}

/**
 * Check if a service is available based on configuration and environment
 */
export function isServiceConfigured(serviceId: string): boolean {
  const config = getBuiltInServiceConfig(serviceId);
  return config !== null && config.isEnabled;
}

/**
 * Get all available built-in services
 */
export function getAvailableBuiltInServices(): BuiltInServiceConfig[] {
  return Object.keys(BUILT_IN_SERVICES)
    .map(serviceId => getBuiltInServiceConfig(serviceId))
    .filter((config): config is BuiltInServiceConfig => config !== null);
}

/**
 * Mask API key for logging/display purposes
 */
export function maskApiKey(apiKey: string): string {
  if (!apiKey || apiKey.length <= SECURITY_SETTINGS.API_KEY_MASK_LENGTH) {
    return '***';
  }
  
  const visibleLength = SECURITY_SETTINGS.API_KEY_MASK_LENGTH;
  const maskedPart = '*'.repeat(apiKey.length - visibleLength);
  const visiblePart = apiKey.slice(-visibleLength);
  
  return maskedPart + visiblePart;
}
