/**
 * Built-in Service Configuration Manager
 * Manages built-in service configurations and API keys
 * Validates: Requirements 2.4, 6.1
 */

import {
  BuiltInServiceConfig,
  ValidationResult,
  BuiltInServiceError,
  BuiltInServiceErrorCodes
} from '../types';
import { BuiltInServiceConfigManager, ConfigurationStorage } from '../interfaces';
import {
  getBuiltInServiceConfig,
  BUILT_IN_SERVICES,
  VALIDATION_RULES,
  CACHE_TTL,
  maskApiKey
} from '../config';

// 🔧 FIX (2026-05-07): seeyjys.zeabur.app 已下线（旧 Render 转 Zeabur 的过渡网关），
//   当前生产网关是 api.seeyjys.eu.org。但管理面板写入的 catalog（数据库）以及残留
//   的 .env.local 都可能仍然带有旧地址，导致 desktop 端拿到错误 baseUrl 后调用失败
//   出现 502 Bad Gateway。这里在所有 baseUrl 出口加一道运行时迁移：命中旧主机时
//   自动改写到新主机，并在 console 留 warn 让运维知道源头还需要修。
const LEGACY_BUILT_IN_BASE_HOSTS: Record<string, string> = {
  'seeyjys.zeabur.app': 'api.seeyjys.eu.org',
};

const migrateLegacyBuiltInBaseUrl = (baseUrl: string): string => {
  const trimmed = (baseUrl || '').trim();
  if (!trimmed) return trimmed;
  try {
    const parsed = new URL(trimmed);
    const replacement = LEGACY_BUILT_IN_BASE_HOSTS[parsed.hostname.toLowerCase()];
    if (!replacement) return trimmed;
    const original = trimmed.replace(/\/+$/, '');
    parsed.hostname = replacement;
    const rewritten = parsed.toString().replace(/\/+$/, '');
    console.warn(
      `[built-in-api-service] Detected legacy gateway "${original}"; auto-rewriting to "${rewritten}". 请在管理面板/.env 中更新 catalog baseUrl 以彻底消除该警告。`
    );
    return rewritten;
  } catch {
    return trimmed;
  }
};

export class BuiltInServiceConfigManagerImpl implements BuiltInServiceConfigManager {
  private configCache = new Map<string, { config: BuiltInServiceConfig; timestamp: number }>();
  private availabilityCache = new Map<string, { available: boolean; timestamp: number }>();

  constructor(private configStorage: ConfigurationStorage) {}

  /**
   * Get built-in service configuration
   *
   * 🔧 FIX (2026-05-07): 新增可选参数 preferredCategory。视频脚本生成走的是图像
   *   理解（vision/multimodal），但旧实现只取 catalog 第一个 enabled subtask（按
   *   类别迭代顺序），可能拿到 text 分类的 key/baseUrl/model，导致跨分类错配 →
   *   `public API key required`。preferredCategory 设置后，会先尝试该分类的默认
   *   subtask，未命中再退到原顺序。
   */
  async getBuiltInServiceConfig(
    serviceId: string,
    preferredCategory?: string
  ): Promise<BuiltInServiceConfig | null> {
    try {
      // Check cache first
      const cacheKey = preferredCategory
        ? `${serviceId}::${preferredCategory}`
        : serviceId;
      const cached = this.configCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL.SERVICE_CONFIG) {
        return { ...cached.config };
      }

      // 1. catalog（管理面板 UI 配置）优先
      try {
        const { getServiceCatalog } = await import('../db');
        const catalog = await getServiceCatalog();
        // 🔧 FIX (2026-05-07): 按 preferredCategory 重排迭代顺序，让脚本/视觉
        //   类请求优先拿到 vision/multimodal 分类，避免误用 text 分类的 key。
        const allCategoryEntries = Object.entries(catalog) as Array<
          [string, (typeof catalog)[keyof typeof catalog]]
        >;
        const orderedCategoryEntries = preferredCategory
          ? [
              ...allCategoryEntries.filter(([key]) => key === preferredCategory),
              ...allCategoryEntries.filter(([key]) => key !== preferredCategory),
            ]
          : allCategoryEntries;
        for (const [, category] of orderedCategoryEntries) {
          if (!category || !category.subtasks) continue;
          const orderedIds = [
            category.defaultSubtaskId,
            ...Object.keys(category.subtasks).filter(id => id !== category.defaultSubtaskId)
          ];
          for (const subId of orderedIds) {
            const subtask = category.subtasks[subId];
            if (!subtask) continue;
            const baseUrl = migrateLegacyBuiltInBaseUrl(
              (subtask.baseUrl || '').trim()
            );
            const apiKey = (subtask.apiKey || '').trim();
            const enabled = subtask.isEnabled !== false;
            if (enabled && baseUrl && apiKey) {
              const synthesized: BuiltInServiceConfig = {
                id: serviceId,
                name: process.env.BUILT_IN_SERVICE_NAME || '内置服务',
                provider: 'openai',
                baseUrl,
                model: (subtask.model || '').trim() || 'gpt-image-2',
                apiKey,
                isEnabled: true,
                quotaLimits: {
                  dailyRequests: 10000,
                  monthlyRequests: 100000,
                  concurrentRequests: 50
                },
                rateLimits: {
                  requestsPerMinute: 60,
                  requestsPerHour: 1000,
                  burstLimit: 10
                },
                createdAt: new Date(),
                updatedAt: new Date()
              };
              this.configCache.set(cacheKey, {
                config: { ...synthesized },
                timestamp: Date.now()
              });
              return { ...synthesized };
            }
          }
        }
      } catch (catalogErr) {
        console.warn(
          `[getBuiltInServiceConfig] catalog 查询失败:`,
          catalogErr instanceof Error ? catalogErr.message : catalogErr
        );
      }

      // 2. 旧路径：环境变量 fallback
      const config = getBuiltInServiceConfig(serviceId);
      if (config) {
        const healed: BuiltInServiceConfig = {
          ...config,
          baseUrl: migrateLegacyBuiltInBaseUrl(config.baseUrl),
        };
        this.configCache.set(cacheKey, {
          config: { ...healed },
          timestamp: Date.now()
        });
        return { ...healed };
      }

      return null;
    } catch (error) {
      console.error(`Error getting service config for ${serviceId}:`, error);
      return null;
    }
  }

  /**
   * Update built-in service configuration
   */
  async updateBuiltInServiceConfig(serviceId: string, config: BuiltInServiceConfig): Promise<void> {
    try {
      // Validate the configuration
      const validation = await this.validateServiceConfig(config);
      if (!validation.isValid) {
        throw new BuiltInServiceError(
          BuiltInServiceErrorCodes.INVALID_CONFIG,
          `Invalid service configuration: ${validation.errors.join(', ')}`
        );
      }

      // Ensure the service ID matches
      if (config.id !== serviceId) {
        throw new BuiltInServiceError(
          BuiltInServiceErrorCodes.INVALID_CONFIG,
          'Service ID mismatch in configuration'
        );
      }

      // Update timestamp
      config.updatedAt = new Date();

      // Save to storage (this would typically update environment variables or config files)
      const allConfigs = await this.getAllBuiltInServices();
      const existingIndex = allConfigs.findIndex(c => c.id === serviceId);
      
      if (existingIndex >= 0) {
        allConfigs[existingIndex] = config;
      } else {
        allConfigs.push(config);
      }

      await this.configStorage.saveServiceConfigs(allConfigs);

      // Update cache
      this.configCache.set(serviceId, {
        config: { ...config },
        timestamp: Date.now()
      });

      // Clear availability cache since config changed
      this.availabilityCache.delete(serviceId);

      console.log(`Updated service configuration for: ${serviceId}`);
    } catch (error) {
      console.error(`Error updating service config for ${serviceId}:`, error);
      if (error instanceof BuiltInServiceError) {
        throw error;
      }
      throw new BuiltInServiceError(
        BuiltInServiceErrorCodes.INVALID_CONFIG,
        `Failed to update service configuration: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get all built-in services
   */
  async getAllBuiltInServices(): Promise<BuiltInServiceConfig[]> {
    try {
      // Try to load from storage first
      const storedConfigs = await this.configStorage.loadServiceConfigs();
      const mergedById = new Map<string, BuiltInServiceConfig>();

      for (const stored of storedConfigs) {
        mergedById.set(stored.id, stored);
      }

      for (const serviceId of Object.keys(BUILT_IN_SERVICES)) {
        const resolved = await this.getBuiltInServiceConfig(serviceId);
        if (resolved) {
          mergedById.set(serviceId, resolved);
        }
      }

      return Array.from(mergedById.values());
    } catch (error) {
      console.error('Error getting all built-in services:', error);
      const fallbackConfigs: BuiltInServiceConfig[] = [];
      for (const serviceId of Object.keys(BUILT_IN_SERVICES)) {
        const resolved = await this.getBuiltInServiceConfig(serviceId);
        if (resolved) {
          fallbackConfigs.push(resolved);
        }
      }
      return fallbackConfigs;
    }
  }

  /**
   * Validate service configuration
   */
  async validateServiceConfig(config: BuiltInServiceConfig): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // Validate required fields
      if (!config.id || typeof config.id !== 'string' || config.id.trim().length === 0) {
        errors.push('Service ID is required and must be a non-empty string');
      }

      if (!config.name || typeof config.name !== 'string' || config.name.trim().length === 0) {
        errors.push('Service name is required and must be a non-empty string');
      } else if (config.name.length < VALIDATION_RULES.MIN_SERVICE_NAME_LENGTH || 
                 config.name.length > VALIDATION_RULES.MAX_SERVICE_NAME_LENGTH) {
        errors.push(`Service name must be between ${VALIDATION_RULES.MIN_SERVICE_NAME_LENGTH} and ${VALIDATION_RULES.MAX_SERVICE_NAME_LENGTH} characters`);
      }

      if (!config.provider || typeof config.provider !== 'string') {
        errors.push('Provider is required and must be a string');
      }

      if (!config.apiKey || typeof config.apiKey !== 'string') {
        errors.push('API key is required and must be a string');
      } else if (config.apiKey.length > VALIDATION_RULES.MAX_API_KEY_LENGTH) {
        errors.push(`API key is too long (max ${VALIDATION_RULES.MAX_API_KEY_LENGTH} characters)`);
      }

      if (!config.baseUrl || typeof config.baseUrl !== 'string') {
        errors.push('Base URL is required and must be a string');
      } else {
        try {
          new URL(config.baseUrl);
        } catch {
          errors.push('Base URL must be a valid URL');
        }
      }

      if (!config.model || typeof config.model !== 'string') {
        errors.push('Model is required and must be a string');
      }

      if (typeof config.isEnabled !== 'boolean') {
        errors.push('isEnabled must be a boolean');
      }

      // Validate quota limits
      if (!config.quotaLimits || typeof config.quotaLimits !== 'object') {
        errors.push('Quota limits are required and must be an object');
      } else {
        const { quotaLimits } = config;
        
        if (typeof quotaLimits.dailyRequests !== 'number' || quotaLimits.dailyRequests < 0) {
          errors.push('Daily requests must be a non-negative number');
        }

        if (typeof quotaLimits.monthlyRequests !== 'number' || quotaLimits.monthlyRequests < 0) {
          errors.push('Monthly requests must be a non-negative number');
        }

        if (typeof quotaLimits.concurrentRequests !== 'number' || quotaLimits.concurrentRequests < 0) {
          errors.push('Concurrent requests must be a non-negative number');
        }

        // Logical validation
        if (quotaLimits.dailyRequests > quotaLimits.monthlyRequests) {
          warnings.push('Daily requests limit is higher than monthly limit');
        }
      }

      // Validate rate limits
      if (!config.rateLimits || typeof config.rateLimits !== 'object') {
        errors.push('Rate limits are required and must be an object');
      } else {
        const { rateLimits } = config;
        
        if (typeof rateLimits.requestsPerMinute !== 'number' || rateLimits.requestsPerMinute < 0) {
          errors.push('Requests per minute must be a non-negative number');
        }

        if (typeof rateLimits.requestsPerHour !== 'number' || rateLimits.requestsPerHour < 0) {
          errors.push('Requests per hour must be a non-negative number');
        }

        if (typeof rateLimits.burstLimit !== 'number' || rateLimits.burstLimit < 0) {
          errors.push('Burst limit must be a non-negative number');
        }

        // Logical validation
        if (rateLimits.requestsPerMinute * 60 > rateLimits.requestsPerHour) {
          warnings.push('Requests per minute * 60 exceeds requests per hour limit');
        }
      }

      // Validate dates
      if (config.createdAt && !(config.createdAt instanceof Date)) {
        errors.push('Created date must be a valid Date object');
      }

      if (config.updatedAt && !(config.updatedAt instanceof Date)) {
        errors.push('Updated date must be a valid Date object');
      }

      return {
        isValid: errors.length === 0,
        errors,
        warnings
      };
    } catch (error) {
      console.error('Error validating service configuration:', error);
      return {
        isValid: false,
        errors: [`Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`],
        warnings
      };
    }
  }

  /**
   * Check if service is available
   */
  async isServiceAvailable(serviceId: string): Promise<boolean> {
    try {
      // Check cache first
      const cached = this.availabilityCache.get(serviceId);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL.HEALTH_STATUS) {
        return cached.available;
      }

      const config = await this.getBuiltInServiceConfig(serviceId);
      if (!config || !config.isEnabled) {
        this.availabilityCache.set(serviceId, {
          available: false,
          timestamp: Date.now()
        });
        return false;
      }

      const validation = await this.validateServiceConfig(config);
      const available = validation.isValid;

      this.availabilityCache.set(serviceId, {
        available,
        timestamp: Date.now()
      });

      return available;
    } catch (error) {
      console.error(`Error checking service availability for ${serviceId}:`, error);
      return false;
    }
  }

  /**
   * Get default service
   */
  async getDefaultService(): Promise<BuiltInServiceConfig | null> {
    try {
      const allServices = await this.getAllBuiltInServices();
      const availableServices = [];

      // Check which services are available
      for (const service of allServices) {
        if (await this.isServiceAvailable(service.id)) {
          availableServices.push(service);
        }
      }

      if (availableServices.length === 0) {
        return null;
      }

      // Return the first available service (could be enhanced with priority logic)
      return availableServices[0];
    } catch (error) {
      console.error('Error getting default service:', error);
      return null;
    }
  }

  /**
   * Get service configuration summary (with masked API key)
   */
  async getServiceConfigSummary(serviceId: string): Promise<{
    id: string;
    name: string;
    provider: string;
    baseUrl: string;
    model: string;
    isEnabled: boolean;
    isAvailable: boolean;
    maskedApiKey: string;
    quotaLimits: any;
    rateLimits: any;
    lastUpdated: Date;
  } | null> {
    try {
      const config = await this.getBuiltInServiceConfig(serviceId);
      if (!config) {
        return null;
      }

      const isAvailable = await this.isServiceAvailable(serviceId);

      return {
        id: config.id,
        name: config.name,
        provider: config.provider,
        baseUrl: config.baseUrl,
        model: config.model,
        isEnabled: config.isEnabled,
        isAvailable,
        maskedApiKey: maskApiKey(config.apiKey),
        quotaLimits: config.quotaLimits,
        rateLimits: config.rateLimits,
        lastUpdated: config.updatedAt
      };
    } catch (error) {
      console.error(`Error getting service config summary for ${serviceId}:`, error);
      return null;
    }
  }

  /**
   * Clear configuration cache
   */
  clearCache(): void {
    this.configCache.clear();
    this.availabilityCache.clear();
  }

  /**
   * Clear cache for specific service
   */
  clearServiceCache(serviceId: string): void {
    this.configCache.delete(serviceId);
    this.availabilityCache.delete(serviceId);
  }

  /**
   * Get configuration statistics
   */
  async getConfigurationStatistics(): Promise<{
    totalServices: number;
    enabledServices: number;
    availableServices: number;
    providers: string[];
    lastUpdated: Date;
  }> {
    try {
      const allServices = await this.getAllBuiltInServices();
      const enabledServices = allServices.filter(s => s.isEnabled).length;
      
      let availableServices = 0;
      for (const service of allServices) {
        if (await this.isServiceAvailable(service.id)) {
          availableServices++;
        }
      }

      const providers = Array.from(new Set(allServices.map(s => s.provider)));
      const lastUpdated = allServices.reduce((latest, service) => {
        return service.updatedAt > latest ? service.updatedAt : latest;
      }, new Date(0));

      return {
        totalServices: allServices.length,
        enabledServices,
        availableServices,
        providers,
        lastUpdated
      };
    } catch (error) {
      console.error('Error getting configuration statistics:', error);
      return {
        totalServices: 0,
        enabledServices: 0,
        availableServices: 0,
        providers: [],
        lastUpdated: new Date()
      };
    }
  }
}
