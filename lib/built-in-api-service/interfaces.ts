/**
 * Built-in API Service Interfaces
 * Core interface definitions for the built-in API service system
 * Validates: Requirements 2.4, 3.4, 4.1
 */

import {
  BuiltInServiceConfig,
  UserPermissions,
  AuthorizedUser,
  AuthorizationResult,
  ServiceOption,
  SwitchResult,
  ServiceStatus,
  UserServiceConfig,
  CustomAPIConfig,
  ProxyImageRequest,
  UsageRecord,
  ValidationResult,
  ImportResult,
  QuotaLimits
} from './types';

/**
 * Built-in API Service Manager Interface
 * Coordinates all built-in service related functionality
 */
export interface BuiltInAPIServiceManager {
  // User authorization
  checkUserAuthorization(userId: string): Promise<boolean>;
  
  // Service management
  getAvailableServices(userId: string): Promise<ServiceOption[]>;
  switchToBuiltInService(userId: string, serviceId: string): Promise<SwitchResult>;
  switchToCustomService(userId: string, customConfig: CustomAPIConfig): Promise<SwitchResult>;
  getCurrentServiceStatus(userId: string): Promise<ServiceStatus>;
  
  // Configuration management
  getUserServiceConfig(userId: string): Promise<UserServiceConfig | null>;
  updateUserServiceConfig(userId: string, config: Partial<UserServiceConfig>): Promise<void>;
  
  // Cache management
  clearCaches(): void;
}

/**
 * User Authorization Verifier Interface
 * Handles user permission verification
 */
export interface UserAuthorizationVerifier {
  // Permission verification
  verifyUserAuthorization(userId: string): Promise<AuthorizationResult>;
  checkServicePermission(userId: string, serviceId: string): Promise<boolean>;
  getUserPermissions(userId: string): Promise<UserPermissions | null>;
  
  // Permission management
  isUserAuthorized(userId: string): Promise<boolean>;
  getAuthorizedUsers(): Promise<AuthorizedUser[]>;
  
  // Additional methods
  checkUserQuota(userId: string, serviceId: string): Promise<{ hasQuota: boolean; dailyRemaining: number; monthlyRemaining: number }>;
  validateServiceAccess(userId: string, serviceId: string): Promise<{ allowed: boolean; reason: string; errorCode?: string }>;
  
  // Cache management
  clearAllCaches(): void;
}

/**
 * Built-in Service Configuration Manager Interface
 * Manages built-in service configurations and API keys
 */
export interface BuiltInServiceConfigManager {
  // Service configuration
  getBuiltInServiceConfig(serviceId: string): Promise<BuiltInServiceConfig | null>;
  updateBuiltInServiceConfig(serviceId: string, config: BuiltInServiceConfig): Promise<void>;
  getAllBuiltInServices(): Promise<BuiltInServiceConfig[]>;
  
  // Configuration validation
  validateServiceConfig(config: BuiltInServiceConfig): Promise<ValidationResult>;
  
  // Service availability
  isServiceAvailable(serviceId: string): Promise<boolean>;
  getDefaultService(): Promise<BuiltInServiceConfig | null>;
  
  // Statistics and management
  getConfigurationStatistics(): Promise<{ totalServices: number; enabledServices: number; availableServices: number; providers: string[]; lastUpdated: Date }>;
  clearCache(): void;
}

/**
 * API Proxy Layer Interface
 * Handles secure API request proxying
 */
export interface APIProxyLayer {
  // Request proxying
  proxyImageGeneration(request: ProxyImageRequest): Promise<any>;
  batchProxyImageGeneration(requests: ProxyImageRequest[]): Promise<any[]>;
  
  // Request validation
  validateProxyRequest(request: ProxyImageRequest): Promise<boolean>;
  validateServiceForProxying(serviceId: string): Promise<{ isValid: boolean; reason?: string }>;
  
  // Usage tracking
  recordUsage(userId: string, serviceId: string, usage: UsageRecord): Promise<void>;
  exportUsageData(startDate?: Date, endDate?: Date): any[];
  
  // Health checking
  checkServiceHealth(serviceId: string): Promise<boolean>;
  
  // Statistics
  getUsageStatistics(userId?: string, serviceId?: string): { totalRequests: number; successfulRequests: number; failedRequests: number; averageResponseTime: number; recentRequests: UsageRecord[] };
  getSystemStatistics(): any;
  getUserQuotaUsage(userId: string): Promise<{ dailyRequests: number; monthlyRequests: number; remainingDaily: number; remainingMonthly: number }>;
  
  // Cache management
  warmUpCache(commonRequests: ProxyImageRequest[]): Promise<void>;
}

/**
 * Permission Manager Interface
 * Manages user permissions and authorization
 */
export interface PermissionManager {
  // User management
  addAuthorizedUser(userId: string, userData: UserPermissions | (UserPermissions & { name?: string; email?: string })): Promise<void>;
  removeAuthorizedUser(userId: string): Promise<void>;
  updateUserPermissions(userId: string, permissions: Partial<UserPermissions>): Promise<void>;
  
  // Bulk operations
  getAllAuthorizedUsers(): Promise<AuthorizedUser[]>;
  importAuthorizedUsers(users: AuthorizedUser[]): Promise<ImportResult>;
  
  // Permission queries
  getUserPermissions(userId: string): Promise<UserPermissions | null>;
  isUserAuthorized(userId: string): Promise<boolean>;
  
  // Configuration management
  loadPermissionConfig(): Promise<void>;
  savePermissionConfig(): Promise<void>;
  
  // Statistics
  getPermissionStatistics(): Promise<{ totalUsers: number; activeUsers: number; suspendedUsers: number; expiredUsers: number; servicesInUse: string[]; lastUpdated: Date }>;
}

/**
 * Usage Statistics Interface
 * Tracks and reports service usage
 */
export interface UsageStatistics {
  // Usage recording
  recordRequest(userId: string, serviceId: string, success: boolean, responseTime: number): Promise<void>;
  recordError(userId: string, serviceId: string, error: string): Promise<void>;
  
  // Usage queries
  getUserUsage(userId: string, serviceId: string, date: Date): Promise<any>;
  getSystemUsage(date: Date): Promise<any>;
  
  // Quota management
  checkQuota(userId: string, serviceId: string): Promise<boolean>;
  updateQuotaUsage(userId: string, serviceId: string, amount: number): Promise<void>;
}

/**
 * Service Health Monitor Interface
 * Monitors built-in service health and availability
 */
export interface ServiceHealthMonitor {
  // Health checking
  checkServiceHealth(serviceId: string): Promise<boolean>;
  checkAllServicesHealth(): Promise<Record<string, boolean>>;
  
  // Status monitoring
  getServiceStatus(serviceId: string): Promise<'healthy' | 'degraded' | 'unavailable'>;
  
  // Alerting
  onServiceDown(serviceId: string, callback: (serviceId: string) => void): void;
  onServiceUp(serviceId: string, callback: (serviceId: string) => void): void;
}

/**
 * Configuration Storage Interface
 * Handles persistent storage of configurations
 */
export interface ConfigurationStorage {
  // Permission storage
  loadPermissions(): Promise<AuthorizedUser[]>;
  savePermissions(users: AuthorizedUser[]): Promise<void>;
  
  // Service configuration storage
  loadServiceConfigs(): Promise<BuiltInServiceConfig[]>;
  saveServiceConfigs(configs: BuiltInServiceConfig[]): Promise<void>;
  
  // User configuration storage
  loadUserConfig(userId: string): Promise<UserServiceConfig | null>;
  saveUserConfig(userId: string, config: UserServiceConfig): Promise<void>;
  updateUserPreferences(userId: string, preferences: Partial<UserServiceConfig['preferences']>): Promise<void>;
  
  // User service history
  getUserServiceHistory(userId: string): Promise<Array<{
    serviceId: string;
    serviceType: 'built-in' | 'custom';
    switchedAt: Date;
    duration?: number;
  }>>;
  recordServiceSwitch(userId: string, serviceId: string, serviceType: 'built-in' | 'custom'): Promise<void>;
  
  // User statistics
  getUserConfigStats(userId: string): Promise<{
    totalSwitches: number;
    builtInUsageTime: number;
    customUsageTime: number;
    preferredService: 'built-in' | 'custom';
    lastActivity: Date | null;
    configCreated: Date | null;
  }>;
  
  // Maintenance
  cleanupOldUserConfigs(maxAgeInDays?: number): Promise<number>;
  
  // Configuration migration and compatibility
  migrateConfiguration(): Promise<{
    migrated: boolean;
    fromVersion: string;
    toVersion: string;
    changes: string[];
  }>;
  validateConfigurationIntegrity(): Promise<{
    isValid: boolean;
    issues: string[];
    recommendations: string[];
  }>;
  
  // Backup and restore
  createBackup(): Promise<string>;
  restoreFromBackup(backupData: string): Promise<void>;
  
  // System management
  initializeConfigurationDirectories(): Promise<void>;
  validateEnvironmentVariables(): { isValid: boolean; missingKeys: string[]; availableServices: string[] };
  checkConfigurationFiles(): Promise<{ permissions: boolean; services: boolean; userConfigsDir: boolean; backupsDir: boolean }>;
}