/**
 * Permission Manager
 * Manages user permissions and authorization configuration
 * Validates: Requirements 4.1, 4.2, 4.5
 */

import {
  AuthorizedUser,
  UserPermissions,
  ImportResult,
  PermissionConfig,
  BuiltInServiceError,
  BuiltInServiceErrorCodes
} from '../types';
import { PermissionManager, ConfigurationStorage } from '../interfaces';
import { DEFAULT_USER_PERMISSIONS, VALIDATION_RULES } from '../config';
import {
  isDatabaseAvailable,
  saveUserToDatabase,
  deleteUserFromDatabase
} from '../db';

export class PermissionManagerImpl implements PermissionManager {
  private permissionConfig: PermissionConfig | null = null;
  private changeLog: Array<{
    timestamp: Date;
    action: string;
    userId?: string;
    details: any;
  }> = [];
  private dbAvailable: boolean | null = null;
  private lastDbCheckAt = 0;
  private static readonly DB_RECHECK_INTERVAL_MS = 15000;

  constructor(private configStorage: ConfigurationStorage) {}

  /**
   * Check if database is available (cached)
   */
  private async checkDatabaseAvailability(): Promise<boolean> {
    const now = Date.now();
    const shouldReuseCache =
      this.dbAvailable !== null &&
      now - this.lastDbCheckAt < PermissionManagerImpl.DB_RECHECK_INTERVAL_MS;

    if (shouldReuseCache) {
      return this.dbAvailable as boolean;
    }

    this.dbAvailable = await isDatabaseAvailable();
    this.lastDbCheckAt = now;
    return this.dbAvailable;
  }

  /**
   * Add a new authorized user
   */
  async addAuthorizedUser(userId: string, userData: UserPermissions | (UserPermissions & { name?: string; email?: string })): Promise<void> {
    try {
      this.validateUserId(userId);
      
      // Extract permissions and user info
      const { name, email, ...permissions } = userData as any;
      this.validatePermissions(permissions);

      await this.ensureConfigLoaded();
      
      // Check if user already exists
      const existingUserIndex = this.permissionConfig!.authorizedUsers.findIndex(
        user => user.userId === userId
      );

      const newUser: AuthorizedUser = {
        userId,
        email: email || userId, // Use email if provided, otherwise use userId
        name: name || email || userId, // Use name if provided, otherwise use email or userId
        permissions: {
          ...permissions,
          grantedAt: new Date(),
          grantedBy: 'system' // In a real implementation, this would be the admin user ID
        },
        status: 'active'
      };

      if (existingUserIndex >= 0) {
        // Update existing user
        this.permissionConfig!.authorizedUsers[existingUserIndex] = newUser;
        this.logChange('update_user', userId, { permissions, name, email });
      } else {
        // Add new user
        this.permissionConfig!.authorizedUsers.push(newUser);
        this.logChange('add_user', userId, { permissions, name, email });
      }

      this.permissionConfig!.lastUpdated = new Date();
      await this.savePermissionConfig();

      console.log(`Added/updated authorized user: ${userId} (${name || email || userId})`);
    } catch (error) {
      console.error('Error adding authorized user:', error);
      throw new BuiltInServiceError(
        BuiltInServiceErrorCodes.INVALID_CONFIG,
        `Failed to add authorized user: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Remove an authorized user
   */
  async removeAuthorizedUser(userId: string): Promise<void> {
    try {
      this.validateUserId(userId);
      await this.ensureConfigLoaded();

      const userIndex = this.permissionConfig!.authorizedUsers.findIndex(
        user => user.userId === userId
      );

      if (userIndex === -1) {
        throw new BuiltInServiceError(
          BuiltInServiceErrorCodes.USER_NOT_FOUND,
          `User not found: ${userId}`
        );
      }

      const removedUser = this.permissionConfig!.authorizedUsers[userIndex];
      this.permissionConfig!.authorizedUsers.splice(userIndex, 1);
      this.permissionConfig!.lastUpdated = new Date();

      this.logChange('remove_user', userId, { removedUser });
      await this.savePermissionConfig();

      console.log(`Removed authorized user: ${userId}`);
    } catch (error) {
      console.error('Error removing authorized user:', error);
      if (error instanceof BuiltInServiceError) {
        throw error;
      }
      throw new BuiltInServiceError(
        BuiltInServiceErrorCodes.INVALID_CONFIG,
        `Failed to remove authorized user: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Update user permissions
   */
  async updateUserPermissions(userId: string, permissions: Partial<UserPermissions>): Promise<void> {
    try {
      this.validateUserId(userId);
      await this.ensureConfigLoaded();

      const userIndex = this.permissionConfig!.authorizedUsers.findIndex(
        user => user.userId === userId
      );

      if (userIndex === -1) {
        throw new BuiltInServiceError(
          BuiltInServiceErrorCodes.USER_NOT_FOUND,
          `User not found: ${userId}`
        );
      }

      const user = this.permissionConfig!.authorizedUsers[userIndex];
      const oldPermissions = { ...user.permissions };

      // Merge permissions
      user.permissions = {
        ...user.permissions,
        ...permissions,
        grantedAt: user.permissions.grantedAt, // Preserve original grant date
        grantedBy: user.permissions.grantedBy   // Preserve original granter
      };

      this.validatePermissions(user.permissions);

      this.permissionConfig!.lastUpdated = new Date();
      this.logChange('update_permissions', userId, { 
        oldPermissions, 
        newPermissions: user.permissions 
      });

      await this.savePermissionConfig();

      console.log(`Updated permissions for user: ${userId}`);
    } catch (error) {
      console.error('Error updating user permissions:', error);
      if (error instanceof BuiltInServiceError) {
        throw error;
      }
      throw new BuiltInServiceError(
        BuiltInServiceErrorCodes.INVALID_CONFIG,
        `Failed to update user permissions: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get all authorized users
   */
  async getAllAuthorizedUsers(): Promise<AuthorizedUser[]> {
    try {
      await this.ensureConfigLoaded();
      return [...this.permissionConfig!.authorizedUsers];
    } catch (error) {
      console.error('Error getting authorized users:', error);
      return [];
    }
  }

  /**
   * Import authorized users from array
   */
  async importAuthorizedUsers(users: AuthorizedUser[]): Promise<ImportResult> {
    const result: ImportResult = {
      success: true,
      imported: 0,
      failed: 0,
      errors: []
    };

    try {
      await this.ensureConfigLoaded();

      for (const user of users) {
        try {
          this.validateUserId(user.userId);
          this.validatePermissions(user.permissions);

          // Check if user already exists
          const existingIndex = this.permissionConfig!.authorizedUsers.findIndex(
            existing => existing.userId === user.userId
          );

          if (existingIndex >= 0) {
            // Update existing user
            this.permissionConfig!.authorizedUsers[existingIndex] = {
              ...user,
              status: user.status || 'active'
            };
          } else {
            // Add new user
            this.permissionConfig!.authorizedUsers.push({
              ...user,
              status: user.status || 'active'
            });
          }

          result.imported++;
          this.logChange('import_user', user.userId, { user });
        } catch (error) {
          result.failed++;
          result.errors.push(`Failed to import user ${user.userId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      if (result.imported > 0) {
        this.permissionConfig!.lastUpdated = new Date();
        await this.savePermissionConfig();
      }

      if (result.failed > 0) {
        result.success = false;
      }

      console.log(`Import completed: ${result.imported} imported, ${result.failed} failed`);
      return result;
    } catch (error) {
      console.error('Error importing authorized users:', error);
      return {
        success: false,
        imported: 0,
        failed: users.length,
        errors: [`Import failed: ${error instanceof Error ? error.message : 'Unknown error'}`]
      };
    }
  }

  /**
   * Get user permissions
   */
  async getUserPermissions(userId: string): Promise<UserPermissions | null> {
    try {
      await this.ensureConfigLoaded();
      const user = this.permissionConfig!.authorizedUsers.find(u => u.userId === userId);
      return user ? { ...user.permissions } : null;
    } catch (error) {
      console.error('Error getting user permissions:', error);
      return null;
    }
  }

  /**
   * Check if user is authorized
   */
  async isUserAuthorized(userId: string): Promise<boolean> {
    try {
      const permissions = await this.getUserPermissions(userId);
      if (!permissions) {
        return false;
      }

      const user = (await this.getAllAuthorizedUsers()).find(u => u.userId === userId);
      return user?.status === 'active' && permissions.canUseBuiltInServices;
    } catch (error) {
      console.error('Error checking user authorization:', error);
      return false;
    }
  }

  /**
   * Load permission configuration
   */
  async loadPermissionConfig(): Promise<void> {
    try {
      const users = await this.configStorage.loadPermissions();
      const serviceConfigs = await this.configStorage.loadServiceConfigs();

      this.permissionConfig = {
        version: '1.0.0',
        lastUpdated: new Date(),
        authorizedUsers: users,
        defaultPermissions: DEFAULT_USER_PERMISSIONS,
        serviceConfigs
      };

      this.logChange('load_config', undefined, { userCount: users.length });
      console.log(`Loaded permission configuration with ${users.length} users`);
    } catch (error) {
      console.error('Error loading permission configuration:', error);
      
      // Initialize with empty configuration if loading fails
      this.permissionConfig = {
        version: '1.0.0',
        lastUpdated: new Date(),
        authorizedUsers: [],
        defaultPermissions: DEFAULT_USER_PERMISSIONS,
        serviceConfigs: []
      };
    }
  }

  /**
   * Save permission configuration
   */
  async savePermissionConfig(): Promise<void> {
    try {
      if (!this.permissionConfig) {
        throw new Error('No permission configuration to save');
      }

      // Check if database is available
      const dbAvailable = await this.checkDatabaseAvailability();

      if (dbAvailable) {
        // Save to database (ConfigurationStorage will handle this)
        await this.configStorage.savePermissions(this.permissionConfig.authorizedUsers);
      } else {
        // Fallback to file storage
        await this.configStorage.savePermissions(this.permissionConfig.authorizedUsers);
      }

      await this.configStorage.saveServiceConfigs(this.permissionConfig.serviceConfigs);

      this.logChange('save_config', undefined, { 
        userCount: this.permissionConfig.authorizedUsers.length 
      });

      console.log('Permission configuration saved successfully');
    } catch (error) {
      console.error('Error saving permission configuration:', error);
      throw new BuiltInServiceError(
        BuiltInServiceErrorCodes.INVALID_CONFIG,
        `Failed to save permission configuration: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get permission change log
   */
  getChangeLog(): Array<{
    timestamp: Date;
    action: string;
    userId?: string;
    details: any;
  }> {
    return [...this.changeLog];
  }

  /**
   * Clear change log
   */
  clearChangeLog(): void {
    this.changeLog = [];
  }

  /**
   * Get permission statistics
   */
  async getPermissionStatistics(): Promise<{
    totalUsers: number;
    activeUsers: number;
    suspendedUsers: number;
    expiredUsers: number;
    servicesInUse: string[];
    lastUpdated: Date;
  }> {
    try {
      await this.ensureConfigLoaded();
      
      const users = this.permissionConfig!.authorizedUsers;
      const activeUsers = users.filter(u => u.status === 'active').length;
      const suspendedUsers = users.filter(u => u.status === 'suspended').length;
      const expiredUsers = users.filter(u => u.status === 'expired').length;
      
      const servicesInUse = Array.from(new Set(
        users.flatMap(u => u.permissions.allowedServices)
      ));

      return {
        totalUsers: users.length,
        activeUsers,
        suspendedUsers,
        expiredUsers,
        servicesInUse,
        lastUpdated: this.permissionConfig!.lastUpdated
      };
    } catch (error) {
      console.error('Error getting permission statistics:', error);
      return {
        totalUsers: 0,
        activeUsers: 0,
        suspendedUsers: 0,
        expiredUsers: 0,
        servicesInUse: [],
        lastUpdated: new Date()
      };
    }
  }

  /**
   * Ensure configuration is loaded
   */
  private async ensureConfigLoaded(): Promise<void> {
    if (!this.permissionConfig) {
      await this.loadPermissionConfig();
    }
  }

  /**
   * Validate user ID
   */
  private validateUserId(userId: string): void {
    if (!userId || typeof userId !== 'string') {
      throw new Error('User ID must be a non-empty string');
    }

    const trimmed = userId.trim();
    if (trimmed.length < VALIDATION_RULES.MIN_USER_ID_LENGTH || 
        trimmed.length > VALIDATION_RULES.MAX_USER_ID_LENGTH) {
      throw new Error(`User ID must be between ${VALIDATION_RULES.MIN_USER_ID_LENGTH} and ${VALIDATION_RULES.MAX_USER_ID_LENGTH} characters`);
    }
  }

  /**
   * Validate permissions object
   */
  private validatePermissions(permissions: UserPermissions): void {
    if (!permissions || typeof permissions !== 'object') {
      throw new Error('Permissions must be a valid object');
    }

    if (typeof permissions.canUseBuiltInServices !== 'boolean') {
      throw new Error('canUseBuiltInServices must be a boolean');
    }

    if (!Array.isArray(permissions.allowedServices)) {
      throw new Error('allowedServices must be an array');
    }

    if (!permissions.quotaLimits || typeof permissions.quotaLimits !== 'object') {
      throw new Error('quotaLimits must be a valid object');
    }

    const { quotaLimits } = permissions;
    if (typeof quotaLimits.dailyRequests !== 'number' || quotaLimits.dailyRequests < 0) {
      throw new Error('dailyRequests must be a non-negative number');
    }

    if (typeof quotaLimits.monthlyRequests !== 'number' || quotaLimits.monthlyRequests < 0) {
      throw new Error('monthlyRequests must be a non-negative number');
    }

    if (typeof quotaLimits.concurrentRequests !== 'number' || quotaLimits.concurrentRequests < 0) {
      throw new Error('concurrentRequests must be a non-negative number');
    }
  }

  /**
   * Log permission changes
   */
  private logChange(action: string, userId?: string, details?: any): void {
    this.changeLog.push({
      timestamp: new Date(),
      action,
      userId,
      details
    });

    // Keep only the last 1000 log entries
    if (this.changeLog.length > 1000) {
      this.changeLog = this.changeLog.slice(-1000);
    }

    console.log(`Permission change logged: ${action}${userId ? ` for user ${userId}` : ''}`);
  }
}
