/**
 * Built-in API Service Configuration
 * Configuration constants and defaults for the built-in API service system
 * Validates: Requirements 2.4, 3.4, 4.1
 */

import { BuiltInServiceConfig, UserPermissions, QuotaLimits, RateLimitConfig } from './types';
// 🔧 FIX (2026-06-11 BUG-C20): 占位 key 识别（env 兜底 key 可能是模板残留）
import { isPlaceholderApiKey } from './placeholder-key';

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
    // 🔧 FIX (2026-05 #9): seeyjys.zeabur.app 是已弃用的旧地址，整个服务早就
    // 迁移到 api.seeyjys.eu.org（部署在 Render）。旧 Zeabur 节点要么不响应、
    // 要么超时 → 30s AbortController 强制中断 → "操作被超时中断"。
    // 优先读 GEMINI_BUILT_IN_BASE_URL 环境变量，无则用新地址兜底。
    baseUrl: process.env.GEMINI_BUILT_IN_BASE_URL || 'https://api.seeyjys.eu.org/v1',
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
  // 🔧 FIX (2026-05 #8 真根因): gpt-image-2 在 2048x1152 这种大尺寸经过 Zeabur
  // 代理到上游模型，单次生成普遍要 60-120 秒。30 秒会被 AbortController 强制
  // 中断 → "operation was aborted due to timeout" → 重试 3 次仍超时 → 502。
  // 把外层 wrapper 拉到 180s，给上游充分的生成时间。
  API_REQUEST: 180000,      // 3 minutes (was 30s — too short for image gen)
  HEALTH_CHECK: 10000,      // 10 seconds
  CONFIG_LOAD: 5000         // 5 seconds
} as const;

// Error retry configuration
export const RETRY_CONFIG = {
  // 🔧 FIX (2026-05 #8): 3 次重试 × 180s/次 = 9 分钟，UX 灾难。图像生成失败
  // 大概率不是瞬时抖动而是上游容量/限流，重试 1 次足矣。
  MAX_RETRIES: 1,
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
 *
 * 🔧 FIX (2026-05 #10): apiKey 读取改为 fallback 链。
 *   背景：用户上游 api.seeyjys.eu.org/v1 是 OpenAI 兼容模式（不是 Gemini 原生 API），
 *   服务 ID `gemini-built-in` 只是历史命名遗留。此前代码硬绑定
 *   provider==='gemini' → 必读 GEMINI_BUILT_IN_API_KEY，用户删掉该变量改用 OpenAI
 *   兼容模式后整个服务变 unavailable。
 *
 *   修复策略：每个 provider 都按"专属变量 → 通用变量 BUILT_IN_API_KEY → 跨家族
 *   fallback"的优先级读，任一存在即视为已配置，避免下游名字不重要的死配。
 */
export function getBuiltInServiceConfig(serviceId: string): BuiltInServiceConfig | null {
  const baseConfig = BUILT_IN_SERVICES[serviceId];
  if (!baseConfig) {
    return null;
  }

  // 通用兜底变量：不绑定具体厂商名，便于运维只配一个 key
  const genericKey = process.env.BUILT_IN_API_KEY || '';

  // Get API key from environment with fallback chain
  let apiKey = '';
  switch (baseConfig.provider) {
    case 'gemini':
      apiKey =
        process.env[ENV_KEYS.GEMINI_BUILT_IN_API_KEY] ||
        process.env[ENV_KEYS.OPENAI_BUILT_IN_API_KEY] || // OpenAI 兼容上游 fallback
        genericKey ||
        '';
      break;
    case 'openai':
      apiKey =
        process.env[ENV_KEYS.OPENAI_BUILT_IN_API_KEY] ||
        process.env[ENV_KEYS.GEMINI_BUILT_IN_API_KEY] ||
        genericKey ||
        '';
      break;
    case 'claude':
      apiKey =
        process.env[ENV_KEYS.CLAUDE_BUILT_IN_API_KEY] ||
        genericKey ||
        '';
      break;
  }

  // 🔧 FIX (2026-06-11 BUG-C20): env 里残留的占位 key（sk-test/sk-demo/your-api-key 等）
  // 视同未配置，避免拿模板值打上游产生 401 噪音。
  if (!apiKey || isPlaceholderApiKey(apiKey)) {
    console.warn(
      `No usable API key found for built-in service: ${serviceId} ` +
      `(tried ${baseConfig.provider.toUpperCase()}_BUILT_IN_API_KEY, ` +
      `OPENAI_BUILT_IN_API_KEY, GEMINI_BUILT_IN_API_KEY, BUILT_IN_API_KEY — ` +
      `all empty or placeholder)`
    );
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
