/**
 * Built-in API Service - Main Export
 * Central export point for the built-in API service system
 * Validates: Requirements 2.4, 3.4, 4.1
 */

// Core types and interfaces
export * from './types';
export * from './interfaces';
export * from './config';

// Main manager and utilities
export * from './manager';

// Re-export commonly used types for convenience
export type {
  BuiltInServiceConfig,
  UserPermissions,
  AuthorizedUser,
  ServiceOption,
  SwitchResult,
  ServiceStatus,
  ProxyImageRequest,
  UsageRecord
} from './types';

export type {
  BuiltInAPIServiceManager,
  UserAuthorizationVerifier,
  BuiltInServiceConfigManager,
  APIProxyLayer,
  PermissionManager
} from './interfaces';

// Configuration utilities
export {
  DEFAULT_QUOTA_LIMITS,
  DEFAULT_USER_PERMISSIONS,
  BUILT_IN_SERVICES,
  getBuiltInServiceConfig,
  isServiceConfigured,
  getAvailableBuiltInServices,
  maskApiKey
} from './config';

// Error codes for easy access
export { BuiltInServiceErrorCodes } from './types';