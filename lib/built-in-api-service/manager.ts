/**
 * Built-in API Service Manager - Main Integration
 * Central manager that coordinates all built-in API service components
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4
 */

import {
  BuiltInAPIServiceManager,
  UserAuthorizationVerifier,
  BuiltInServiceConfigManager,
  APIProxyLayer,
  PermissionManager,
  ConfigurationStorage
} from './interfaces';

import { UserAuthorizationVerifierImpl } from './components/user-authorization-verifier';
import { PermissionManagerImpl } from './components/permission-manager';
import { BuiltInServiceConfigManagerImpl } from './components/service-config-manager';
import { APIProxyLayerImpl } from './components/api-proxy-layer';
import { BuiltInAPIServiceManagerImpl } from './components/service-manager';
import { ConfigurationStorageImpl } from './components/configuration-storage';
import { isDatabaseAvailable, initializeDatabase } from './db';
import { buildSystemHealthStatus, SystemHealthStatus } from './system-health';

import {
  ServiceOption,
  SwitchResult,
  ServiceStatus,
  UserServiceConfig,
  CustomAPIConfig,
  ProxyImageRequest,
  BuiltInServiceError,
  BuiltInServiceErrorCodes,
  ErrorRecoveryStrategy
} from './types';

// 🔧 FIX (2026-06-11 类型门禁): serviceManager 字段原声明为窄接口
// BuiltInAPIServiceManager，但实际构造的是 BuiltInAPIServiceManagerImpl——
// 它同时实现 ErrorRecoveryStrategy（recover/fallbackToCustomAPI/checkServiceHealth）
// 并附带 getErrorRecoveryStats/resetErrorRecovery 扩展方法，下方各转发方法的
// 属性访问全部 TS2339。按"运行时可选能力"建模（Partial），保留既有 if 探测分支
// 语义；仅类型层修正，运行时行为不变。
type ServiceManagerWithRecovery = BuiltInAPIServiceManager &
  Partial<ErrorRecoveryStrategy> & {
    getErrorRecoveryStats?: () => any;
    resetErrorRecovery?: (userId: string, serviceId?: string) => void;
  };

/**
 * Main Built-in API Service Manager
 * Singleton instance that provides access to all built-in API service functionality
 */
export class BuiltInAPIService {
  private static instance: BuiltInAPIService | null = null;
  
  private configStorage: ConfigurationStorage;
  private authVerifier: UserAuthorizationVerifier;
  private permissionManager: PermissionManager;
  private configManager: BuiltInServiceConfigManager;
  private proxyLayer: APIProxyLayer;
  private serviceManager: ServiceManagerWithRecovery;
  
  private initialized = false;

  private constructor(workspaceRoot?: string) {
    // Initialize components
    this.configStorage = new ConfigurationStorageImpl(workspaceRoot);
    this.authVerifier = new UserAuthorizationVerifierImpl(this.configStorage);
    this.permissionManager = new PermissionManagerImpl(this.configStorage);
    this.configManager = new BuiltInServiceConfigManagerImpl(this.configStorage);
    this.proxyLayer = new APIProxyLayerImpl(this.configManager, this.authVerifier);
    this.serviceManager = new BuiltInAPIServiceManagerImpl(
      this.authVerifier,
      this.configManager,
      this.proxyLayer,
      this.configStorage
    );
  }

  /**
   * Get singleton instance
   */
  static getInstance(workspaceRoot?: string): BuiltInAPIService {
    if (!BuiltInAPIService.instance) {
      BuiltInAPIService.instance = new BuiltInAPIService(workspaceRoot);
    }
    return BuiltInAPIService.instance;
  }

  /**
   * Initialize the built-in API service system
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      console.log('Initializing Built-in API Service...');

      try {
        const dbReady = await isDatabaseAvailable();
        if (dbReady) {
          await initializeDatabase();
        } else {
          console.warn('Built-in API Service: database unavailable, skipping table initialization');
        }
      } catch (dbInitError) {
        console.error('Built-in API Service: database initialization failed:', dbInitError);
      }

      // Initialize configuration directories
      await this.configStorage.initializeConfigurationDirectories();

      // Load permission configuration
      await this.permissionManager.loadPermissionConfig();

      // Validate environment variables
      const envValidation = this.configStorage.validateEnvironmentVariables();
      if (!envValidation.isValid) {
        console.warn('Some built-in services may not be available due to missing API keys:', envValidation.missingKeys);
      } else {
        console.log('Available built-in services:', envValidation.availableServices);
      }

      this.initialized = true;
      console.log('Built-in API Service initialized successfully');
    } catch (error) {
      console.error('Failed to initialize Built-in API Service:', error);
      throw new BuiltInServiceError(
        BuiltInServiceErrorCodes.INVALID_CONFIG,
        `Initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Check if user is authorized to use built-in services
   */
  async checkUserAuthorization(userId: string): Promise<boolean> {
    await this.ensureInitialized();
    return this.serviceManager.checkUserAuthorization(userId);
  }

  /**
   * Get available services for a user
   */
  async getAvailableServices(userId: string): Promise<ServiceOption[]> {
    await this.ensureInitialized();
    return this.serviceManager.getAvailableServices(userId);
  }

  /**
   * Get catalog-aware built-in service configuration
   */
  async getBuiltInServiceConfig(serviceId: string) {
    await this.ensureInitialized();
    return this.configManager.getBuiltInServiceConfig(serviceId);
  }

  /**
   * Switch user to built-in service
   */
  async switchToBuiltInService(userId: string, serviceId: string): Promise<SwitchResult> {
    await this.ensureInitialized();
    return this.serviceManager.switchToBuiltInService(userId, serviceId);
  }

  /**
   * Switch user to custom service
   */
  async switchToCustomService(userId: string, customConfig: CustomAPIConfig): Promise<SwitchResult> {
    await this.ensureInitialized();
    return this.serviceManager.switchToCustomService(userId, customConfig);
  }

  /**
   * Get current service status for user
   */
  async getCurrentServiceStatus(userId: string): Promise<ServiceStatus> {
    await this.ensureInitialized();
    return this.serviceManager.getCurrentServiceStatus(userId);
  }

  /**
   * Proxy image generation request
   */
  async proxyImageGeneration(request: ProxyImageRequest): Promise<any> {
    await this.ensureInitialized();
    return this.proxyLayer.proxyImageGeneration(request);
  }

  /**
   * Add authorized user (admin function)
   */
  async addAuthorizedUser(userId: string, permissions: any): Promise<void> {
    await this.ensureInitialized();
    return this.permissionManager.addAuthorizedUser(userId, permissions);
  }

  /**
   * Remove authorized user (admin function)
   */
  async removeAuthorizedUser(userId: string): Promise<void> {
    await this.ensureInitialized();
    return this.permissionManager.removeAuthorizedUser(userId);
  }

  /**
   * Get all authorized users (admin function)
   */
  async getAllAuthorizedUsers(): Promise<any[]> {
    await this.ensureInitialized();
    return this.permissionManager.getAllAuthorizedUsers();
  }

  /**
   * Get service usage statistics
   */
  getUsageStatistics(userId?: string, serviceId?: string): any {
    return this.proxyLayer.getUsageStatistics(userId, serviceId);
  }

  /**
   * Get comprehensive system statistics
   */
  getSystemStatistics(): any {
    return this.proxyLayer.getSystemStatistics();
  }

  /**
   * Get user quota usage
   * 🔧 UPDATED: Now async to support database queries
   */
  async getUserQuotaUsage(userId: string): Promise<any> {
    return this.proxyLayer.getUserQuotaUsage(userId);
  }

  /**
   * Export usage data for analytics
   */
  exportUsageData(startDate?: Date, endDate?: Date): any[] {
    return this.proxyLayer.exportUsageData(startDate, endDate);
  }

  /**
   * Recover from service errors
   */
  async recoverFromError(error: any, context: { userId: string; serviceId: string; originalRequest?: any }): Promise<any> {
    if (this.serviceManager.recover) {
      return this.serviceManager.recover(error, context);
    }
    throw new Error('Error recovery not implemented');
  }

  /**
   * Fallback to custom API
   */
  async fallbackToCustomAPI(userId: string, originalRequest: any): Promise<any> {
    if (this.serviceManager.fallbackToCustomAPI) {
      return this.serviceManager.fallbackToCustomAPI(userId, originalRequest);
    }
    throw new Error('Fallback to custom API not implemented');
  }

  /**
   * Check service health
   */
  async checkServiceHealth(serviceId: string): Promise<any> {
    if (this.serviceManager.checkServiceHealth) {
      return this.serviceManager.checkServiceHealth(serviceId);
    }
    return { isHealthy: false, error: 'Health check not implemented' };
  }

  /**
   * Get error recovery statistics
   */
  getErrorRecoveryStats(): any {
    if (this.serviceManager.getErrorRecoveryStats) {
      return this.serviceManager.getErrorRecoveryStats();
    }
    return { totalRecoveryAttempts: 0, activeRecoveries: 0, recentFailures: [] };
  }

  /**
   * Reset error recovery for user/service
   */
  resetErrorRecovery(userId: string, serviceId?: string): void {
    if (this.serviceManager.resetErrorRecovery) {
      this.serviceManager.resetErrorRecovery(userId, serviceId);
    }
  }

  /**
   * Get system health status
   */
  async getSystemHealthStatus(): Promise<SystemHealthStatus> {
    try {
      try {
        await this.ensureInitialized();
      } catch (initError) {
        console.error('Built-in service initialization failed during health check:', initError);
      }

      // Check service health
      const serviceHealth: Record<string, boolean> = {};
      try {
        const allServices = await this.configManager.getAllBuiltInServices();
        for (const service of allServices) {
          serviceHealth[service.id] = await this.proxyLayer.checkServiceHealth(service.id);
        }
      } catch (serviceError) {
        console.error('Error checking built-in service health:', serviceError);
      }

      // Check permissions system
      const permissionsHealthy = await this.permissionManager.getAllAuthorizedUsers()
        .then(() => true)
        .catch(() => false);

      // Check storage system
      const storageFiles = await this.configStorage.checkConfigurationFiles()
        .catch((storageError) => {
          console.error('Error checking local configuration files:', storageError);
          return null;
        });
      const databaseAvailable = await isDatabaseAvailable().catch((dbError) => {
        console.error('Error checking database-backed configuration storage:', dbError);
        return false;
      });

      return buildSystemHealthStatus({
        services: serviceHealth,
        permissions: permissionsHealthy,
        storageFiles,
        databaseAvailable,
      });
    } catch (error) {
      console.error('Error checking system health:', error);
      return {
        isHealthy: false,
        services: {},
        permissions: false,
        storage: false,
        lastChecked: new Date()
      };
    }
  }

  /**
   * Get configuration summary
   */
  async getConfigurationSummary(): Promise<{
    totalServices: number;
    availableServices: number;
    totalUsers: number;
    activeUsers: number;
    environmentStatus: any;
  }> {
    try {
      await this.ensureInitialized();

      const configStats = await this.configManager.getConfigurationStatistics();
      const permissionStats = await this.permissionManager.getPermissionStatistics();
      const envValidation = this.configStorage.validateEnvironmentVariables();

      return {
        totalServices: configStats.totalServices,
        availableServices: configStats.availableServices,
        totalUsers: permissionStats.totalUsers,
        activeUsers: permissionStats.activeUsers,
        environmentStatus: envValidation
      };
    } catch (error) {
      console.error('Error getting configuration summary:', error);
      return {
        totalServices: 0,
        availableServices: 0,
        totalUsers: 0,
        activeUsers: 0,
        environmentStatus: { isValid: false, missingKeys: [], availableServices: [] }
      };
    }
  }

  /**
   * Clear all caches
   */
  clearCaches(): void {
    this.serviceManager.clearCaches();
    this.authVerifier.clearAllCaches();
    this.configManager.clearCache();
  }

  /**
   * Ensure system is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * Reset singleton instance (for testing)
   */
  static resetInstance(): void {
    BuiltInAPIService.instance = null;
  }
}

/**
 * Convenience function to get the built-in API service instance
 */
export function getBuiltInAPIService(workspaceRoot?: string): BuiltInAPIService {
  return BuiltInAPIService.getInstance(workspaceRoot);
}

/**
 * Initialize built-in API service system
 */
export async function initializeBuiltInAPIService(workspaceRoot?: string): Promise<BuiltInAPIService> {
  const service = getBuiltInAPIService(workspaceRoot);
  await service.initialize();
  return service;
}

// Export types for external use
export type {
  ServiceOption,
  SwitchResult,
  ServiceStatus,
  UserServiceConfig,
  CustomAPIConfig,
  ProxyImageRequest
} from './types';

export { BuiltInServiceErrorCodes } from './types';
