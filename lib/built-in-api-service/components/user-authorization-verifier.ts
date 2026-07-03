/**
 * User Authorization Verifier
 * Handles user permission verification for built-in API services
 * Validates: Requirements 3.1, 4.3
 */

import {
  AuthorizationResult,
  UserPermissions,
  AuthorizedUser,
  BuiltInServiceError,
  BuiltInServiceErrorCodes
} from '../types';
import { UserAuthorizationVerifier, ConfigurationStorage } from '../interfaces';
import { DEFAULT_USER_PERMISSIONS, CACHE_TTL } from '../config';
import { logUserAuth, logServiceAccess, logSecurityEvent } from './audit-logger';

export class UserAuthorizationVerifierImpl implements UserAuthorizationVerifier {
  private permissionsCache = new Map<string, { permissions: UserPermissions; timestamp: number }>();
  private authorizedUsersCache: { users: AuthorizedUser[]; timestamp: number } | null = null;

  constructor(private configStorage: ConfigurationStorage) {}

  private normalizeIdentifier(value: string): string {
    return value.trim().toLowerCase();
  }

  private findUserByIdentifier(users: AuthorizedUser[], identifier: string): AuthorizedUser | undefined {
    const normalized = this.normalizeIdentifier(identifier);
    return users.find((user) => {
      const userId = this.normalizeIdentifier(user.userId || "");
      const email = this.normalizeIdentifier(user.email || "");
      return userId === normalized || (email && email === normalized);
    });
  }

  /**
   * Verify user authorization with caching
   */
  async verifyUserAuthorization(userId: string): Promise<AuthorizationResult> {
    try {
      console.log('[AuthVerifier] verifyUserAuthorization called for:', userId);
      
      if (!userId || userId.trim().length === 0) {
        console.log('[AuthVerifier] Invalid user ID');
        // Log invalid user ID attempt
        logSecurityEvent('invalid_user_id_attempt', undefined, {
          providedUserId: userId,
          reason: 'Empty or invalid user ID'
        });
        
        return {
          isAuthorized: false,
          permissions: [],
          reason: 'Invalid user ID'
        };
      }

      console.log('[AuthVerifier] Getting user permissions...');
      const permissions = await this.getUserPermissions(userId);
      console.log('[AuthVerifier] Permissions:', permissions);
      
      if (!permissions) {
        console.log('[AuthVerifier] No permissions found for user');
        // Log unauthorized user attempt
        logUserAuth(userId, 'authorization_check', false, {
          reason: 'User not found in authorized users list'
        });
        
        return {
          isAuthorized: false,
          permissions: [],
          reason: 'User not found in authorized users list'
        };
      }

      // Check if user is active
      console.log('[AuthVerifier] Getting authorized users list...');
      const authorizedUsers = await this.getAuthorizedUsers();
      console.log('[AuthVerifier] Total authorized users:', authorizedUsers.length);
      console.log('[AuthVerifier] Authorized users:', authorizedUsers.map(u => u.userId));
      
      const user = this.findUserByIdentifier(authorizedUsers, userId);
      console.log('[AuthVerifier] Found user:', user ? 'YES' : 'NO');
      
      if (!user) {
        console.log('[AuthVerifier] User not found in authorized users list');
        // Log user not found
        logUserAuth(userId, 'authorization_check', false, {
          reason: 'User not found'
        });
        
        return {
          isAuthorized: false,
          permissions: [],
          reason: 'User not found'
        };
      }

      console.log('[AuthVerifier] User status:', user.status);
      if (user.status !== 'active') {
        console.log('[AuthVerifier] User status is not active');
        // Log inactive user attempt
        logUserAuth(userId, 'authorization_check', false, {
          reason: `User status is ${user.status}`,
          userStatus: user.status
        });
        
        return {
          isAuthorized: false,
          permissions: [],
          reason: `User status is ${user.status}`
        };
      }

      // Check if permissions have expired (if expiration is set)
      // For now, we don't implement expiration, but the structure is ready

      const isAuthorized = permissions.canUseBuiltInServices;
      console.log('[AuthVerifier] canUseBuiltInServices:', isAuthorized);
      console.log('[AuthVerifier] allowedServices:', permissions.allowedServices);
      
      // Log authorization result
      logUserAuth(userId, 'authorization_check', isAuthorized, {
        permissions: permissions.allowedServices,
        quotaLimits: permissions.quotaLimits
      });

      const result = {
        isAuthorized,
        permissions: permissions.allowedServices,
        reason: isAuthorized ? 'User is authorized' : 'User lacks built-in service permissions'
      };
      
      console.log('[AuthVerifier] Final result:', result);
      return result;
    } catch (error) {
      console.error('[AuthVerifier] Error verifying user authorization:', error);
      console.error('[AuthVerifier] Error stack:', error instanceof Error ? error.stack : 'No stack');
      
      // Log authorization error
      logUserAuth(userId, 'authorization_error', false, {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      
      return {
        isAuthorized: false,
        permissions: [],
        reason: 'Authorization verification failed'
      };
    }
  }

  /**
   * Check if user has permission for a specific service
   */
  async checkServicePermission(userId: string, serviceId: string): Promise<boolean> {
    try {
      const authResult = await this.verifyUserAuthorization(userId);
      
      if (!authResult.isAuthorized) {
        return false;
      }

      const permissions = await this.getUserPermissions(userId);
      if (!permissions) {
        return false;
      }

      // Check if user has access to this specific service
      return permissions.allowedServices.includes(serviceId) || 
             permissions.allowedServices.includes('*'); // Wildcard permission
    } catch (error) {
      console.error('Error checking service permission:', error);
      return false;
    }
  }

  /**
   * Get user permissions with caching
   */
  async getUserPermissions(userId: string): Promise<UserPermissions | null> {
    try {
      // Check cache first
      const cached = this.permissionsCache.get(userId);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL.PERMISSIONS) {
        return cached.permissions;
      }

      // Load from storage
      const authorizedUsers = await this.getAuthorizedUsers();
      const user = this.findUserByIdentifier(authorizedUsers, userId);
      
      if (!user) {
        return null;
      }

      // Cache the result
      this.permissionsCache.set(userId, {
        permissions: user.permissions,
        timestamp: Date.now()
      });

      return user.permissions;
    } catch (error) {
      console.error('Error getting user permissions:', error);
      return null;
    }
  }

  /**
   * Simple authorization check
   */
  async isUserAuthorized(userId: string): Promise<boolean> {
    const authResult = await this.verifyUserAuthorization(userId);
    return authResult.isAuthorized;
  }

  /**
   * Get all authorized users with caching
   */
  async getAuthorizedUsers(): Promise<AuthorizedUser[]> {
    try {
      // Check cache first
      if (this.authorizedUsersCache && 
          this.authorizedUsersCache.users.length > 0 &&
          Date.now() - this.authorizedUsersCache.timestamp < CACHE_TTL.PERMISSIONS) {
        return this.authorizedUsersCache.users;
      }

      // Load from storage
      const users = await this.configStorage.loadPermissions();

      // Cache only non-empty results to avoid long stale empty cache after cold start.
      if (users.length > 0) {
        this.authorizedUsersCache = {
          users,
          timestamp: Date.now()
        };
      } else {
        this.authorizedUsersCache = null;
      }

      return users;
    } catch (error) {
      console.error('Error loading authorized users:', error);
      return [];
    }
  }

  /**
   * Clear permissions cache for a specific user
   */
  clearUserCache(userId: string): void {
    this.permissionsCache.delete(userId);
  }

  /**
   * Clear all caches
   */
  clearAllCaches(): void {
    this.permissionsCache.clear();
    this.authorizedUsersCache = null;
  }

  /**
   * Validate user ID format
   */
  private validateUserId(userId: string): boolean {
    if (!userId || typeof userId !== 'string') {
      return false;
    }

    const trimmed = userId.trim();
    return trimmed.length >= 3 && trimmed.length <= 100;
  }

  /**
   * Get user authorization summary for debugging
   */
  async getAuthorizationSummary(userId: string): Promise<{
    userId: string;
    isAuthorized: boolean;
    permissions: UserPermissions | null;
    user: AuthorizedUser | null;
    reason: string;
  }> {
    const authResult = await this.verifyUserAuthorization(userId);
    const permissions = await this.getUserPermissions(userId);
    const users = await this.getAuthorizedUsers();
    const user = this.findUserByIdentifier(users, userId) || null;

    return {
      userId,
      isAuthorized: authResult.isAuthorized,
      permissions,
      user,
      reason: authResult.reason || 'Unknown'
    };
  }

  /**
   * Check if user has quota remaining for a service
   */
  async checkUserQuota(userId: string, serviceId: string): Promise<{
    hasQuota: boolean;
    dailyRemaining: number;
    monthlyRemaining: number;
  }> {
    try {
      const permissions = await this.getUserPermissions(userId);
      if (!permissions) {
        return { hasQuota: false, dailyRemaining: 0, monthlyRemaining: 0 };
      }

      // 🔧 MERGE (2026-07-03 镜像合并): 桌面侧的真实配额检查取代占位实现——
      //   对照 api_usage_records 实际用量计算剩余额度，两仓统一。
      const { getUserUsageStats } = await import('../db');
      const usageStats = await getUserUsageStats(userId);
      const dailyLimit = Math.max(0, permissions.quotaLimits.dailyRequests || 0);
      const monthlyLimit = Math.max(0, permissions.quotaLimits.monthlyRequests || 0);
      const dailyRemaining = Math.max(0, dailyLimit - usageStats.dailyUsage);
      const monthlyRemaining = Math.max(0, monthlyLimit - usageStats.monthlyUsage);

      return {
        hasQuota: dailyRemaining > 0 && monthlyRemaining > 0,
        dailyRemaining,
        monthlyRemaining
      };
    } catch (error) {
      console.error('Error checking user quota:', error);
      return { hasQuota: false, dailyRemaining: 0, monthlyRemaining: 0 };
    }
  }

  /**
   * Get user's allowed services
   */
  async getUserAllowedServices(userId: string): Promise<string[]> {
    try {
      const permissions = await this.getUserPermissions(userId);
      return permissions?.allowedServices || [];
    } catch (error) {
      console.error('Error getting user allowed services:', error);
      return [];
    }
  }

  /**
   * Validate service access with detailed error information
   */
  async validateServiceAccess(userId: string, serviceId: string): Promise<{
    allowed: boolean;
    reason: string;
    errorCode?: string;
    permissions?: string[];
  }> {
    try {
      // Check basic authorization
      const authResult = await this.verifyUserAuthorization(userId);
      if (!authResult.isAuthorized) {
        // Log service access denied
        logServiceAccess(userId, serviceId, 'access_denied', false, {
          reason: authResult.reason,
          stage: 'authorization_check'
        });
        
        return {
          allowed: false,
          reason: authResult.reason || 'User not authorized',
          errorCode: BuiltInServiceErrorCodes.PERMISSION_DENIED
        };
      }

      // Check service-specific permission
      const hasServicePermission = await this.checkServicePermission(userId, serviceId);
      if (!hasServicePermission) {
        // Log service permission denied
        logServiceAccess(userId, serviceId, 'permission_denied', false, {
          reason: `User does not have permission for service: ${serviceId}`,
          stage: 'service_permission_check'
        });
        
        return {
          allowed: false,
          reason: `User does not have permission for service: ${serviceId}`,
          errorCode: BuiltInServiceErrorCodes.PERMISSION_DENIED
        };
      }

      // Check quota
      const quotaCheck = await this.checkUserQuota(userId, serviceId);
      if (!quotaCheck.hasQuota) {
        // Log quota exceeded
        logServiceAccess(userId, serviceId, 'quota_exceeded', false, {
          reason: 'User has exceeded quota limits',
          dailyRemaining: quotaCheck.dailyRemaining,
          monthlyRemaining: quotaCheck.monthlyRemaining,
          stage: 'quota_check'
        });
        
        return {
          allowed: false,
          reason: 'User has exceeded quota limits',
          errorCode: BuiltInServiceErrorCodes.QUOTA_EXCEEDED
        };
      }

      // Log successful access validation
      logServiceAccess(userId, serviceId, 'access_granted', true, {
        permissions: authResult.permissions,
        quotaRemaining: {
          daily: quotaCheck.dailyRemaining,
          monthly: quotaCheck.monthlyRemaining
        }
      });

      return {
        allowed: true,
        reason: 'Access granted',
        permissions: authResult.permissions
      };
    } catch (error) {
      console.error('Error validating service access:', error);
      
      // Log validation error
      logServiceAccess(userId, serviceId, 'validation_error', false, {
        error: error instanceof Error ? error.message : 'Unknown error',
        stage: 'validation_process'
      });
      
      return {
        allowed: false,
        reason: 'Service access validation failed',
        errorCode: BuiltInServiceErrorCodes.PERMISSION_DENIED
      };
    }
  }
}
