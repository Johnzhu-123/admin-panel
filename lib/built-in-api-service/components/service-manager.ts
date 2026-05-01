/**
 * Built-in API Service Manager
 * Main orchestrator for built-in API service functionality
 * Validates: Requirements 1.2, 3.1, 5.5
 */

import {
  ServiceOption,
  SwitchResult,
  ServiceStatus,
  UserServiceConfig,
  CustomAPIConfig,
  BuiltInServiceError,
  BuiltInServiceErrorCodes,
  ErrorRecoveryStrategy,
  RecoveryResult,
  FallbackResult,
  HealthStatus
} from '../types';
import {
  BuiltInAPIServiceManager,
  UserAuthorizationVerifier,
  BuiltInServiceConfigManager,
  APIProxyLayer,
  ConfigurationStorage
} from '../interfaces';
import { DEFAULT_USER_PERMISSIONS, CACHE_TTL, RETRY_CONFIG } from '../config';

export class BuiltInAPIServiceManagerImpl implements BuiltInAPIServiceManager, ErrorRecoveryStrategy {
  private userConfigCache = new Map<string, { config: UserServiceConfig; timestamp: number }>();
  private serviceOptionsCache: { options: ServiceOption[]; timestamp: number } | null = null;
  private errorRecoveryAttempts = new Map<string, { count: number; lastAttempt: Date }>();
  private serviceHealthStatus = new Map<string, { isHealthy: boolean; lastChecked: Date; consecutiveFailures: number }>();

  constructor(
    private authVerifier: UserAuthorizationVerifier,
    private configManager: BuiltInServiceConfigManager,
    private proxyLayer: APIProxyLayer,
    private configStorage: ConfigurationStorage
  ) {
    // Start periodic health checks
    setInterval(() => this.performHealthChecks(), 5 * 60 * 1000); // Every 5 minutes
  }

  /**
   * Check if user is authorized to use built-in services
   */
  async checkUserAuthorization(userId: string): Promise<boolean> {
    try {
      return await this.authVerifier.isUserAuthorized(userId);
    } catch (error) {
      console.error('Error checking user authorization:', error);
      return false;
    }
  }

  /**
   * Get available services for a user
   */
  async getAvailableServices(userId: string): Promise<ServiceOption[]> {
    try {
      // Check cache first
      if (this.serviceOptionsCache && 
          Date.now() - this.serviceOptionsCache.timestamp < CACHE_TTL.SERVICE_CONFIG) {
        return this.filterServicesByUserPermissions(userId, this.serviceOptionsCache.options);
      }

      // Get all built-in services
      const builtInServices = await this.configManager.getAllBuiltInServices();
      const serviceOptions: ServiceOption[] = [];

      // Convert built-in services to service options
      for (const service of builtInServices) {
        const isAvailable = await this.configManager.isServiceAvailable(service.id);
        
        serviceOptions.push({
          id: service.id,
          name: service.name,
          description: `Built-in ${service.provider} service - ${service.model}`,
          provider: service.provider,
          isBuiltIn: true,
          isAvailable: isAvailable && service.isEnabled
        });
      }

      // Add custom service option
      serviceOptions.push({
        id: 'custom',
        name: 'Custom API Configuration',
        description: 'Use your own API keys and configuration',
        provider: 'custom',
        isBuiltIn: false,
        isAvailable: true
      });

      // Cache the result
      this.serviceOptionsCache = {
        options: serviceOptions,
        timestamp: Date.now()
      };

      return this.filterServicesByUserPermissions(userId, serviceOptions);
    } catch (error) {
      console.error('Error getting available services:', error);
      // Return at least the custom option as fallback
      return [{
        id: 'custom',
        name: 'Custom API Configuration',
        description: 'Use your own API keys and configuration',
        provider: 'custom',
        isBuiltIn: false,
        isAvailable: true
      }];
    }
  }

  /**
   * Switch user to built-in service
   */
  async switchToBuiltInService(userId: string, serviceId: string): Promise<SwitchResult> {
    try {
      // Check user authorization
      const isAuthorized = await this.checkUserAuthorization(userId);
      if (!isAuthorized) {
        return {
          success: false,
          serviceId,
          message: 'User is not authorized to use built-in services',
          error: BuiltInServiceErrorCodes.PERMISSION_DENIED
        };
      }

      // Check service permission
      const hasServicePermission = await this.authVerifier.checkServicePermission(userId, serviceId);
      if (!hasServicePermission) {
        return {
          success: false,
          serviceId,
          message: `User does not have permission for service: ${serviceId}`,
          error: BuiltInServiceErrorCodes.PERMISSION_DENIED
        };
      }

      // Validate service exists and is available
      const serviceConfig = await this.configManager.getBuiltInServiceConfig(serviceId);
      if (!serviceConfig) {
        return {
          success: false,
          serviceId,
          message: `Service not found: ${serviceId}`,
          error: BuiltInServiceErrorCodes.SERVICE_NOT_FOUND
        };
      }

      const isAvailable = await this.configManager.isServiceAvailable(serviceId);
      if (!isAvailable) {
        return {
          success: false,
          serviceId,
          message: `Service is currently unavailable: ${serviceId}`,
          error: BuiltInServiceErrorCodes.SERVICE_UNAVAILABLE
        };
      }

      // Get or create user configuration
      let userConfig = await this.getUserServiceConfig(userId);
      if (!userConfig) {
        userConfig = {
          userId,
          currentServiceType: 'built-in',
          builtInServiceId: serviceId,
          preferences: {
            autoSwitchToBuiltIn: true,
            preferredModel: serviceConfig.model,
            defaultSize: '1024x1024',
            defaultQuality: 'standard'
          },
          createdAt: new Date(),
          updatedAt: new Date()
        };
      } else {
        userConfig.currentServiceType = 'built-in';
        userConfig.builtInServiceId = serviceId;
        userConfig.customConfig = undefined; // Clear custom config
        userConfig.updatedAt = new Date();
      }

      // Save user configuration
      await this.updateUserServiceConfig(userId, userConfig);

      // Record service switch in history
      await this.configStorage.recordServiceSwitch(userId, serviceId, 'built-in');

      // Clear cache
      this.userConfigCache.delete(userId);

      console.log(`User ${userId} switched to built-in service: ${serviceId}`);

      return {
        success: true,
        serviceId,
        message: `Successfully switched to built-in service: ${serviceConfig.name}`
      };
    } catch (error) {
      console.error('Error switching to built-in service:', error);
      return {
        success: false,
        serviceId,
        message: `Failed to switch to built-in service: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error: BuiltInServiceErrorCodes.PROXY_ERROR
      };
    }
  }

  /**
   * Switch user to custom service
   */
  async switchToCustomService(userId: string, customConfig: CustomAPIConfig): Promise<SwitchResult> {
    try {
      // Validate custom configuration
      const validation = this.validateCustomConfig(customConfig);
      if (!validation.isValid) {
        return {
          success: false,
          serviceId: 'custom',
          message: `Invalid custom configuration: ${validation.errors.join(', ')}`,
          error: BuiltInServiceErrorCodes.INVALID_CONFIG
        };
      }

      // Get or create user configuration
      let userConfig = await this.getUserServiceConfig(userId);
      if (!userConfig) {
        userConfig = {
          userId,
          currentServiceType: 'custom',
          customConfig,
          preferences: {
            autoSwitchToBuiltIn: false,
            preferredModel: customConfig.model,
            defaultSize: '1024x1024',
            defaultQuality: 'standard'
          },
          createdAt: new Date(),
          updatedAt: new Date()
        };
      } else {
        userConfig.currentServiceType = 'custom';
        userConfig.customConfig = customConfig;
        userConfig.builtInServiceId = undefined; // Clear built-in service
        userConfig.updatedAt = new Date();
      }

      // Save user configuration
      await this.updateUserServiceConfig(userId, userConfig);

      // Record service switch in history
      await this.configStorage.recordServiceSwitch(userId, 'custom', 'custom');

      // Clear cache
      this.userConfigCache.delete(userId);

      console.log(`User ${userId} switched to custom service`);

      return {
        success: true,
        serviceId: 'custom',
        message: 'Successfully switched to custom API configuration'
      };
    } catch (error) {
      console.error('Error switching to custom service:', error);
      return {
        success: false,
        serviceId: 'custom',
        message: `Failed to switch to custom service: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error: BuiltInServiceErrorCodes.PROXY_ERROR
      };
    }
  }

  /**
   * Get current service status for user
   */
  async getCurrentServiceStatus(userId: string): Promise<ServiceStatus> {
    try {
      const userConfig = await this.getUserServiceConfig(userId);
      
      if (!userConfig) {
        // Return default custom service status
        return {
          isUsingBuiltIn: false,
          currentService: {
            id: 'custom',
            name: 'Custom API Configuration',
            description: 'Use your own API keys and configuration',
            provider: 'custom',
            isBuiltIn: false,
            isAvailable: true
          },
          lastSwitched: new Date()
        };
      }

      if (userConfig.currentServiceType === 'built-in' && userConfig.builtInServiceId) {
        const serviceConfig = await this.configManager.getBuiltInServiceConfig(userConfig.builtInServiceId);
        const isAvailable = serviceConfig ? await this.configManager.isServiceAvailable(userConfig.builtInServiceId) : false;
        
        return {
          isUsingBuiltIn: true,
          currentService: {
            id: userConfig.builtInServiceId,
            name: serviceConfig?.name || 'Unknown Service',
            description: serviceConfig ? `Built-in ${serviceConfig.provider} service - ${serviceConfig.model}` : 'Service not found',
            provider: serviceConfig?.provider || 'unknown',
            isBuiltIn: true,
            isAvailable: isAvailable && (serviceConfig?.isEnabled || false)
          },
          lastSwitched: userConfig.updatedAt
        };
      } else {
        return {
          isUsingBuiltIn: false,
          currentService: {
            id: 'custom',
            name: 'Custom API Configuration',
            description: userConfig.customConfig ? 
              `Custom ${userConfig.customConfig.model} via ${userConfig.customConfig.baseUrl}` :
              'Use your own API keys and configuration',
            provider: 'custom',
            isBuiltIn: false,
            isAvailable: true
          },
          lastSwitched: userConfig.updatedAt
        };
      }
    } catch (error) {
      console.error('Error getting current service status:', error);
      // Return safe default
      return {
        isUsingBuiltIn: false,
        currentService: {
          id: 'custom',
          name: 'Custom API Configuration',
          description: 'Use your own API keys and configuration',
          provider: 'custom',
          isBuiltIn: false,
          isAvailable: true
        },
        lastSwitched: new Date()
      };
    }
  }

  /**
   * Get user service configuration
   */
  async getUserServiceConfig(userId: string): Promise<UserServiceConfig | null> {
    try {
      // Check cache first
      const cached = this.userConfigCache.get(userId);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL.USER_CONFIG) {
        return { ...cached.config };
      }

      // Load from storage
      const config = await this.configStorage.loadUserConfig(userId);
      
      if (config) {
        // Cache the result
        this.userConfigCache.set(userId, {
          config: { ...config },
          timestamp: Date.now()
        });
      }

      return config;
    } catch (error) {
      console.error(`Error getting user service config for ${userId}:`, error);
      return null;
    }
  }

  /**
   * Update user service configuration
   */
  async updateUserServiceConfig(userId: string, config: Partial<UserServiceConfig>): Promise<void> {
    try {
      let existingConfig = await this.getUserServiceConfig(userId);
      
      if (!existingConfig) {
        // Create new configuration
        existingConfig = {
          userId,
          currentServiceType: 'custom',
          preferences: {
            autoSwitchToBuiltIn: false,
            preferredModel: '',
            defaultSize: '1024x1024',
            defaultQuality: 'standard'
          },
          createdAt: new Date(),
          updatedAt: new Date()
        };
      }

      // Merge configurations
      const updatedConfig: UserServiceConfig = {
        ...existingConfig,
        ...config,
        userId, // Ensure userId is not overwritten
        updatedAt: new Date()
      };

      // Save to storage
      await this.configStorage.saveUserConfig(userId, updatedConfig);

      // Update cache
      this.userConfigCache.set(userId, {
        config: { ...updatedConfig },
        timestamp: Date.now()
      });

      console.log(`Updated user service configuration for: ${userId}`);
    } catch (error) {
      console.error(`Error updating user service config for ${userId}:`, error);
      throw new BuiltInServiceError(
        BuiltInServiceErrorCodes.INVALID_CONFIG,
        `Failed to update user configuration: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Filter services by user permissions
   */
  private async filterServicesByUserPermissions(userId: string, services: ServiceOption[]): Promise<ServiceOption[]> {
    try {
      const isAuthorized = await this.checkUserAuthorization(userId);
      
      if (!isAuthorized) {
        // Return only custom service for unauthorized users
        return services.filter(s => !s.isBuiltIn);
      }

      // Get user permissions to filter allowed services
      const permissions = await this.authVerifier.getUserPermissions(userId);
      if (!permissions) {
        return services.filter(s => !s.isBuiltIn);
      }

      return services.filter(service => {
        if (!service.isBuiltIn) {
          return true; // Always allow custom services
        }
        
        // Check if user has permission for this built-in service
        return permissions.allowedServices.includes(service.id) || 
               permissions.allowedServices.includes('*');
      });
    } catch (error) {
      console.error('Error filtering services by permissions:', error);
      // Return only custom service as fallback
      return services.filter(s => !s.isBuiltIn);
    }
  }

  /**
   * Validate custom configuration
   */
  private validateCustomConfig(config: CustomAPIConfig): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!config.baseUrl || typeof config.baseUrl !== 'string') {
      errors.push('Base URL is required');
    } else {
      try {
        new URL(config.baseUrl);
      } catch {
        errors.push('Base URL must be a valid URL');
      }
    }

    if (!config.apiKey || typeof config.apiKey !== 'string') {
      errors.push('API key is required');
    }

    if (!config.model || typeof config.model !== 'string') {
      errors.push('Model is required');
    }

    if (!config.authType || !['bearer', 'api_key', 'custom_header'].includes(config.authType)) {
      errors.push('Auth type must be one of: bearer, api_key, custom_header');
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  /**
   * Clear all caches
   */
  clearCaches(): void {
    this.userConfigCache.clear();
    this.serviceOptionsCache = null;
  }

  /**
   * Clear cache for specific user
   */
  clearUserCache(userId: string): void {
    this.userConfigCache.delete(userId);
  }

  /**
   * Get service usage summary for user
   */
  async getServiceUsageSummary(userId: string): Promise<{
    currentService: ServiceOption;
    isUsingBuiltIn: boolean;
    usageStats: any;
    quotaRemaining?: number;
  }> {
    try {
      const status = await this.getCurrentServiceStatus(userId);
      const usageStats = this.proxyLayer.getUsageStatistics(userId);
      
      let quotaRemaining: number | undefined;
      
      if (status.isUsingBuiltIn) {
        const quotaCheck = await this.authVerifier.checkUserQuota(userId, status.currentService.id);
        quotaRemaining = quotaCheck.dailyRemaining;
      }

      return {
        currentService: status.currentService,
        isUsingBuiltIn: status.isUsingBuiltIn,
        usageStats,
        quotaRemaining
      };
    } catch (error) {
      console.error('Error getting service usage summary:', error);
      throw new BuiltInServiceError(
        BuiltInServiceErrorCodes.PROXY_ERROR,
        `Failed to get usage summary: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  // ========== ERROR RECOVERY AND FALLBACK STRATEGIES ==========

  /**
   * Recover from built-in service errors
   */
  async recover(error: BuiltInServiceError, context: { userId: string; serviceId: string; originalRequest?: any }): Promise<RecoveryResult> {
    const { userId, serviceId } = context;
    const errorKey = `${userId}-${serviceId}`;

    try {
      console.log(`🔄 Attempting error recovery for ${errorKey}, error type: ${error.code}`);

      // Track recovery attempts
      const attempts = this.errorRecoveryAttempts.get(errorKey) || { count: 0, lastAttempt: new Date(0) };
      const timeSinceLastAttempt = Date.now() - attempts.lastAttempt.getTime();

      // Prevent too frequent recovery attempts
      if (timeSinceLastAttempt < RETRY_CONFIG.INITIAL_DELAY) {
        return {
          success: false,
          action: 'fail',
          message: 'Recovery attempted too recently, please wait before retrying'
        };
      }

      // Update attempt tracking
      attempts.count++;
      attempts.lastAttempt = new Date();
      this.errorRecoveryAttempts.set(errorKey, attempts);

      // Determine recovery strategy based on error type
      switch (error.code) {
        case BuiltInServiceErrorCodes.PERMISSION_DENIED:
          return await this.handlePermissionError(userId, serviceId);

        case BuiltInServiceErrorCodes.SERVICE_UNAVAILABLE:
          return await this.handleServiceUnavailableError(userId, serviceId, attempts.count);

        case BuiltInServiceErrorCodes.QUOTA_EXCEEDED:
          return await this.handleQuotaExceededError(userId, serviceId);

        case BuiltInServiceErrorCodes.PROXY_ERROR:
          return await this.handleProxyError(userId, serviceId, attempts.count);

        case BuiltInServiceErrorCodes.INVALID_CONFIG:
          return await this.handleConfigError(userId, serviceId);

        default:
          return await this.handleGenericError(userId, serviceId, attempts.count);
      }
    } catch (recoveryError) {
      console.error('Error during recovery process:', recoveryError);
      return {
        success: false,
        action: 'fallback',
        message: 'Recovery process failed, falling back to custom API',
        nextService: 'custom'
      };
    }
  }

  /**
   * Fallback to custom API configuration
   */
  async fallbackToCustomAPI(userId: string, originalRequest: any): Promise<FallbackResult> {
    try {
      console.log(`🔄 Falling back to custom API for user: ${userId}`);

      // Get user's current configuration
      const userConfig = await this.getUserServiceConfig(userId);
      
      if (userConfig?.customConfig) {
        // User has existing custom configuration, switch to it
        const switchResult = await this.switchToCustomService(userId, userConfig.customConfig);
        
        if (switchResult.success) {
          return {
            success: true,
            message: 'Successfully switched to your custom API configuration',
            newServiceId: 'custom',
            requiresUserAction: false
          };
        }
      }

      // No custom configuration available, user needs to configure
      return {
        success: false,
        message: 'Built-in service is unavailable. Please configure your custom API settings.',
        newServiceId: 'custom',
        requiresUserAction: true,
        actionRequired: 'configure_custom_api',
        fallbackInstructions: [
          'Go to API Configuration settings',
          'Enter your API key and base URL',
          'Select your preferred model',
          'Save the configuration'
        ]
      };
    } catch (error) {
      console.error('Error during fallback to custom API:', error);
      return {
        success: false,
        message: 'Failed to fallback to custom API. Please check your configuration.',
        newServiceId: 'custom',
        requiresUserAction: true,
        actionRequired: 'manual_configuration'
      };
    }
  }

  /**
   * Check service health status
   */
  async checkServiceHealth(serviceId: string): Promise<HealthStatus> {
    try {
      const cached = this.serviceHealthStatus.get(serviceId);
      const now = new Date();
      
      // Use cached result if recent (within 2 minutes)
      if (cached && (now.getTime() - cached.lastChecked.getTime()) < 2 * 60 * 1000) {
        return {
          isHealthy: cached.isHealthy,
          lastChecked: cached.lastChecked,
          consecutiveFailures: cached.consecutiveFailures,
          nextCheckTime: new Date(cached.lastChecked.getTime() + 2 * 60 * 1000)
        };
      }

      // Perform actual health check
      const isHealthy = await this.proxyLayer.checkServiceHealth(serviceId);
      const consecutiveFailures = cached ? (isHealthy ? 0 : cached.consecutiveFailures + 1) : (isHealthy ? 0 : 1);

      const healthStatus = {
        isHealthy,
        lastChecked: now,
        consecutiveFailures,
        nextCheckTime: new Date(now.getTime() + 2 * 60 * 1000)
      };

      // Update cache
      this.serviceHealthStatus.set(serviceId, healthStatus);

      return healthStatus;
    } catch (error) {
      console.error(`Error checking health for service ${serviceId}:`, error);
      
      const healthStatus = {
        isHealthy: false,
        lastChecked: new Date(),
        consecutiveFailures: 999,
        nextCheckTime: new Date(Date.now() + 5 * 60 * 1000),
        error: error instanceof Error ? error.message : 'Unknown error'
      };

      this.serviceHealthStatus.set(serviceId, healthStatus);
      return healthStatus;
    }
  }

  // ========== PRIVATE ERROR HANDLING METHODS ==========

  private async handlePermissionError(userId: string, serviceId: string): Promise<RecoveryResult> {
    // Check if user permissions have been updated
    const isAuthorized = await this.checkUserAuthorization(userId);
    
    if (isAuthorized) {
      const hasServicePermission = await this.authVerifier.checkServicePermission(userId, serviceId);
      if (hasServicePermission) {
        return {
          success: true,
          action: 'retry',
          message: 'Permissions have been restored, you can retry the request'
        };
      }
    }

    return {
      success: false,
      action: 'fallback',
      message: 'You do not have permission to use this built-in service. Switching to custom API.',
      nextService: 'custom'
    };
  }

  private async handleServiceUnavailableError(userId: string, serviceId: string, attemptCount: number): Promise<RecoveryResult> {
    const health = await this.checkServiceHealth(serviceId);
    
    if (health.isHealthy) {
      return {
        success: true,
        action: 'retry',
        message: 'Service is now available, you can retry the request'
      };
    }

    // If service has been failing for too long, suggest fallback
    if (health.consecutiveFailures >= 3 || attemptCount >= RETRY_CONFIG.MAX_RETRIES) {
      return {
        success: false,
        action: 'fallback',
        message: 'Built-in service is experiencing issues. Switching to custom API.',
        nextService: 'custom'
      };
    }

    return {
      success: false,
      action: 'retry',
      message: `Service is temporarily unavailable. Please try again in a few minutes. (Attempt ${attemptCount}/${RETRY_CONFIG.MAX_RETRIES})`
    };
  }

  private async handleQuotaExceededError(userId: string, serviceId: string): Promise<RecoveryResult> {
    const quotaCheck = await this.authVerifier.checkUserQuota(userId, serviceId);
    
    if (quotaCheck.dailyRemaining > 0) {
      return {
        success: true,
        action: 'retry',
        message: 'Quota has been refreshed, you can retry the request'
      };
    }

    return {
      success: false,
      action: 'fallback',
      message: 'Daily quota exceeded for built-in service. Switching to custom API.',
      nextService: 'custom'
    };
  }

  private async handleProxyError(userId: string, serviceId: string, attemptCount: number): Promise<RecoveryResult> {
    if (attemptCount < RETRY_CONFIG.MAX_RETRIES) {
      return {
        success: false,
        action: 'retry',
        message: `Request failed due to network issues. Retrying... (${attemptCount}/${RETRY_CONFIG.MAX_RETRIES})`
      };
    }

    return {
      success: false,
      action: 'fallback',
      message: 'Multiple request failures detected. Switching to custom API.',
      nextService: 'custom'
    };
  }

  private async handleConfigError(userId: string, serviceId: string): Promise<RecoveryResult> {
    // Configuration errors usually require admin intervention
    return {
      success: false,
      action: 'fallback',
      message: 'Built-in service configuration error. Please use custom API or contact support.',
      nextService: 'custom'
    };
  }

  private async handleGenericError(userId: string, serviceId: string, attemptCount: number): Promise<RecoveryResult> {
    if (attemptCount < RETRY_CONFIG.MAX_RETRIES) {
      return {
        success: false,
        action: 'retry',
        message: `Unexpected error occurred. Retrying... (${attemptCount}/${RETRY_CONFIG.MAX_RETRIES})`
      };
    }

    return {
      success: false,
      action: 'fallback',
      message: 'Multiple errors detected. Switching to custom API for reliability.',
      nextService: 'custom'
    };
  }

  /**
   * Perform periodic health checks on all services
   */
  private async performHealthChecks(): Promise<void> {
    try {
      const services = await this.configManager.getAllBuiltInServices();
      
      for (const service of services) {
        if (service.isEnabled) {
          await this.checkServiceHealth(service.id);
        }
      }

      console.log('✅ Periodic health checks completed');
    } catch (error) {
      console.error('Error during periodic health checks:', error);
    }
  }

  /**
   * Get error recovery statistics
   */
  getErrorRecoveryStats(): {
    totalRecoveryAttempts: number;
    activeRecoveries: number;
    recentFailures: Array<{ userId: string; serviceId: string; attempts: number; lastAttempt: Date }>;
  } {
    const now = Date.now();
    const recentThreshold = 24 * 60 * 60 * 1000; // 24 hours

    const recentFailures = Array.from(this.errorRecoveryAttempts.entries())
      .filter(([_, attempts]) => now - attempts.lastAttempt.getTime() < recentThreshold)
      .map(([key, attempts]) => {
        const [userId, serviceId] = key.split('-');
        return { userId, serviceId, attempts: attempts.count, lastAttempt: attempts.lastAttempt };
      });

    return {
      totalRecoveryAttempts: Array.from(this.errorRecoveryAttempts.values()).reduce((sum, a) => sum + a.count, 0),
      activeRecoveries: recentFailures.length,
      recentFailures
    };
  }

  /**
   * Reset error recovery tracking for a user/service
   */
  resetErrorRecovery(userId: string, serviceId?: string): void {
    if (serviceId) {
      this.errorRecoveryAttempts.delete(`${userId}-${serviceId}`);
    } else {
      // Reset all for user
      for (const key of this.errorRecoveryAttempts.keys()) {
        if (key.startsWith(`${userId}-`)) {
          this.errorRecoveryAttempts.delete(key);
        }
      }
    }
  }

  /**
   * Update user preferences
   */
  async updateUserPreferences(userId: string, preferences: Partial<UserServiceConfig['preferences']>): Promise<void> {
    try {
      await this.configStorage.updateUserPreferences(userId, preferences);
      
      // Clear cache to force reload
      this.userConfigCache.delete(userId);
      
      console.log(`Updated preferences for user ${userId}`);
    } catch (error) {
      console.error(`Error updating preferences for ${userId}:`, error);
      throw new BuiltInServiceError(
        BuiltInServiceErrorCodes.INVALID_CONFIG,
        `Failed to update user preferences: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get user service history
   */
  async getUserServiceHistory(userId: string): Promise<Array<{
    serviceId: string;
    serviceType: 'built-in' | 'custom';
    switchedAt: Date;
    duration?: number;
  }>> {
    try {
      return await this.configStorage.getUserServiceHistory(userId);
    } catch (error) {
      console.error(`Error getting service history for ${userId}:`, error);
      return [];
    }
  }

  /**
   * Get user configuration statistics
   */
  async getUserConfigurationStats(userId: string): Promise<{
    totalSwitches: number;
    builtInUsageTime: number;
    customUsageTime: number;
    preferredService: 'built-in' | 'custom';
    lastActivity: Date | null;
    configCreated: Date | null;
    usageStats: any;
  }> {
    try {
      const configStats = await this.configStorage.getUserConfigStats(userId);
      const usageStats = this.proxyLayer.getUsageStatistics(userId);
      
      return {
        ...configStats,
        usageStats
      };
    } catch (error) {
      console.error(`Error getting configuration stats for ${userId}:`, error);
      return {
        totalSwitches: 0,
        builtInUsageTime: 0,
        customUsageTime: 0,
        preferredService: 'custom',
        lastActivity: null,
        configCreated: null,
        usageStats: { totalRequests: 0, successfulRequests: 0, failedRequests: 0, averageResponseTime: 0, recentRequests: [] }
      };
    }
  }

  /**
   * Get recommended service for user based on history and preferences
   */
  async getRecommendedService(userId: string): Promise<{
    serviceId: string;
    serviceType: 'built-in' | 'custom';
    reason: string;
    confidence: number; // 0-1
  }> {
    try {
      const stats = await this.getUserConfigurationStats(userId);
      const currentConfig = await this.getUserServiceConfig(userId);
      const isAuthorized = await this.checkUserAuthorization(userId);

      // If user is not authorized, recommend custom
      if (!isAuthorized) {
        return {
          serviceId: 'custom',
          serviceType: 'custom',
          reason: 'User not authorized for built-in services',
          confidence: 1.0
        };
      }

      // If user has auto-switch preference enabled and is authorized
      if (currentConfig?.preferences.autoSwitchToBuiltIn) {
        const availableServices = await this.getAvailableServices(userId);
        const builtInService = availableServices.find(s => s.isBuiltIn && s.isAvailable);
        
        if (builtInService) {
          return {
            serviceId: builtInService.id,
            serviceType: 'built-in',
            reason: 'User preference: auto-switch to built-in enabled',
            confidence: 0.9
          };
        }
      }

      // Base recommendation on usage history
      if (stats.totalSwitches > 5) {
        const confidence = Math.min(0.8, stats.totalSwitches / 20);
        
        if (stats.preferredService === 'built-in') {
          const availableServices = await this.getAvailableServices(userId);
          const builtInService = availableServices.find(s => s.isBuiltIn && s.isAvailable);
          
          if (builtInService) {
            return {
              serviceId: builtInService.id,
              serviceType: 'built-in',
              reason: 'Based on usage history preference',
              confidence
            };
          }
        }
      }

      // Default recommendation
      return {
        serviceId: 'custom',
        serviceType: 'custom',
        reason: 'Default recommendation',
        confidence: 0.5
      };
    } catch (error) {
      console.error(`Error getting recommended service for ${userId}:`, error);
      return {
        serviceId: 'custom',
        serviceType: 'custom',
        reason: 'Error occurred, defaulting to custom',
        confidence: 0.5
      };
    }
  }
}