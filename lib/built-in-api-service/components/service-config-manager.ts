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
  isServiceConfigured,
  getAvailableBuiltInServices,
  BUILT_IN_SERVICES,
  VALIDATION_RULES,
  CACHE_TTL,
  maskApiKey
} from '../config';

export class BuiltInServiceConfigManagerImpl implements BuiltInServiceConfigManager {
  private configCache = new Map<string, { config: BuiltInServiceConfig; timestamp: number }>();
  private availabilityCache = new Map<string, { available: boolean; timestamp: number }>();

  constructor(private configStorage: ConfigurationStorage) {}

  /**
   * Get built-in service configuration
   *
   * 🔧 FIX (2026-05 #11): catalog fallback。env 缺失时从管理面板 UI 配置（catalog）
   *   合成一个可用的 BuiltInServiceConfig，避免下游 proxyImageGeneration 看到 null
   *   后报 "Service not found"。优先 image 类，其他类按 multimodal/text 顺序兜底。
   */
  async getBuiltInServiceConfig(serviceId: string): Promise<BuiltInServiceConfig | null> {
    try {
      // Check cache first
      const cached = this.configCache.get(serviceId);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL.SERVICE_CONFIG) {
        return { ...cached.config };
      }

      // 1. 旧路径：环境变量
      const envConfig = getBuiltInServiceConfig(serviceId);
      if (envConfig) {
        this.configCache.set(serviceId, {
          config: { ...envConfig },
          timestamp: Date.now()
        });
        return { ...envConfig };
      }

      // 2. 新路径：catalog（管理面板 UI 配置）合成 config
      try {
        const { getServiceCatalog } = await import('../db');
        const catalog = await getServiceCatalog();
        // 优先级：image > multimodal > text > tts > video（图片生成路径优先）
        const priority: Array<keyof typeof catalog> = ['image', 'multimodal', 'text', 'tts', 'video'] as any;
        for (const cat of priority) {
          const category = catalog[cat as keyof typeof catalog];
          if (!category || !category.subtasks) continue;
          // 优先用 defaultSubtaskId 指向的子任务，没配齐再轮询其他
          const orderedIds = [
            category.defaultSubtaskId,
            ...Object.keys(category.subtasks).filter(id => id !== category.defaultSubtaskId)
          ];
          for (const subId of orderedIds) {
            const subtask = category.subtasks[subId];
            if (!subtask) continue;
            const baseUrl = (subtask.baseUrl || '').trim();
            const apiKey = (subtask.apiKey || '').trim();
            const enabled = subtask.isEnabled !== false;
            if (enabled && baseUrl && apiKey) {
              const synthesized: BuiltInServiceConfig = {
                id: serviceId,
                name: process.env.BUILT_IN_SERVICE_NAME || '内置服务',
                provider: 'openai', // catalog 模式默认按 OpenAI 兼容协议处理
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
              this.configCache.set(serviceId, {
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
      
      // Merge with default configurations
      const availableServices = getAvailableBuiltInServices();
      const mergedConfigs: BuiltInServiceConfig[] = [];

      // Add stored configurations
      for (const stored of storedConfigs) {
        mergedConfigs.push(stored);
      }

      // Add default configurations that aren't already stored
      for (const available of availableServices) {
        if (!mergedConfigs.find(c => c.id === available.id)) {
          mergedConfigs.push(available);
        }
      }

      return mergedConfigs;
    } catch (error) {
      console.error('Error getting all built-in services:', error);
      // Fallback to default configurations
      return getAvailableBuiltInServices();
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
   *
   * 🔧 FIX (2026-05 #11): 新增 catalog-fallback。
   *   背景：admin-panel 有两套并存的配置体系 ——
   *     (A) 旧路径：环境变量 GEMINI_BUILT_IN_API_KEY / GEMINI_BUILT_IN_BASE_URL；
   *     (B) 新路径：管理面板 UI → catalog（DB），按 5 大类 × N 子任务存 baseUrl+apiKey。
   *   `getAvailableServices` 内部循环调本方法，本方法此前只看 env，UI 配置完全无效。
   *   用户删掉 env 后，桌面端切换内置服务直接报"没有可用的内置服务"。
   *   修复：env 没配时改用 catalog —— 任一 category 有至少一个 enabled 子任务且
   *   配齐 baseUrl+apiKey，就视为该服务可用。
   */
  async isServiceAvailable(serviceId: string): Promise<boolean> {
    try {
      // Check cache first
      const cached = this.availabilityCache.get(serviceId);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL.HEALTH_STATUS) {
        return cached.available;
      }

      // 1. 旧路径：环境变量
      const isEnvConfigured = isServiceConfigured(serviceId);
      if (isEnvConfigured) {
        const config = await this.getBuiltInServiceConfig(serviceId);
        if (config && config.isEnabled) {
          const validation = await this.validateServiceConfig(config);
          const available = validation.isValid;
          this.availabilityCache.set(serviceId, { available, timestamp: Date.now() });
          return available;
        }
      }

      // 2. 新路径：catalog 数据库（管理面板 UI 配置）
      try {
        const { getServiceCatalog } = await import('../db');
        const catalog = await getServiceCatalog();
        for (const category of Object.values(catalog)) {
          if (!category || !category.subtasks) continue;
          for (const subtask of Object.values(category.subtasks)) {
            const baseUrl = (subtask.baseUrl || '').trim();
            const apiKey = (subtask.apiKey || '').trim();
            const enabled = subtask.isEnabled !== false;
            if (enabled && baseUrl && apiKey) {
              this.availabilityCache.set(serviceId, { available: true, timestamp: Date.now() });
              return true;
            }
          }
        }
      } catch (catalogErr) {
        console.warn(
          `[isServiceAvailable] catalog 查询失败，仅 env 路径有效:`,
          catalogErr instanceof Error ? catalogErr.message : catalogErr
        );
      }

      this.availabilityCache.set(serviceId, { available: false, timestamp: Date.now() });
      return false;
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