/**
 * Configuration Storage
 * Handles persistent storage of configurations with security
 * Validates: Requirements 2.4, 2.5
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import {
  AuthorizedUser,
  BuiltInServiceConfig,
  UserServiceConfig,
  BuiltInServiceError,
  BuiltInServiceErrorCodes
} from '../types';
import { ConfigurationStorage } from '../interfaces';
import { CONFIG_PATHS, ENV_KEYS } from '../config';
import {
  isDatabaseAvailable,
  loadUsersFromDatabase,
  saveUserToDatabase,
  deleteUserFromDatabase,
  initializeDatabase,
} from '../db';

const isEphemeralRuntime = () =>
  process.env.VERCEL === '1' ||
  Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) ||
  process.env.RENDER === 'true' ||
  Boolean(process.env.RENDER_SERVICE_ID) ||
  Boolean(process.env.RENDER_EXTERNAL_HOSTNAME);

export class ConfigurationStorageImpl implements ConfigurationStorage {
  private readonly workspaceRoot: string;
  private dbAvailable: boolean | null = null;
  private lastDbCheckAt = 0;
  private static readonly DB_RECHECK_INTERVAL_MS = 15000;

  constructor(workspaceRoot?: string) {
    const electronUserData = process.env.ELECTRON_USER_DATA_DIR;
    if (electronUserData && !workspaceRoot) {
      this.workspaceRoot = join(electronUserData, "md2ppt-data");
    } else {
      this.workspaceRoot = workspaceRoot || process.cwd();
    }
  }

  /**
   * Check if database is available (cached)
   */
  private async checkDatabaseAvailability(): Promise<boolean> {
    const now = Date.now();
    const shouldReuseCache =
      this.dbAvailable !== null &&
      now - this.lastDbCheckAt < ConfigurationStorageImpl.DB_RECHECK_INTERVAL_MS;

    if (shouldReuseCache) {
      return this.dbAvailable as boolean;
    }

    this.dbAvailable = await isDatabaseAvailable();
    this.lastDbCheckAt = now;
    return this.dbAvailable;
  }

  /**
   * Load authorized users from storage
   * Priority: Database > File > Environment Variable
   */
  async loadPermissions(): Promise<AuthorizedUser[]> {
    try {
      console.log('[ConfigStorage] loadPermissions called');
      const allUsers: AuthorizedUser[] = [];

      // 1. Try to load from database (highest priority)
      try {
        console.log('[ConfigStorage] Checking database availability...');
        const dbAvailable = await this.checkDatabaseAvailability();
        console.log('[ConfigStorage] Database available:', dbAvailable);
        
        if (dbAvailable) {
          console.log('[ConfigStorage] Loading users from database...');
          const dbUsers = await loadUsersFromDatabase();
          console.log('[ConfigStorage] Loaded users from database:', dbUsers.length);
          console.log('[ConfigStorage] User details:', JSON.stringify(dbUsers, null, 2));
          allUsers.push(...dbUsers);
          console.log(`✅ Loaded ${dbUsers.length} users from database`);
        }
      } catch (dbError) {
        console.error('[ConfigStorage] Database load failed:', dbError);
        console.warn('Database load failed, falling back to local storage:', dbError);
      }

      // 2. If no database users, load from permissions file as fallback
      if (allUsers.length === 0) {
        console.log('[ConfigStorage] No database users, trying permissions file...');
        const fileUsers = await this.loadUsersFromFile();
        if (fileUsers.length > 0) {
          console.log(`??Loaded ${fileUsers.length} users from permissions file`);
          allUsers.push(...fileUsers);
        }
      }

      // 3. If still no users, load from environment variable as fallback
      if (allUsers.length === 0) {
        console.log('[ConfigStorage] No file users, trying environment variable...');
        const envUsers = this.loadUsersFromEnvironment();
        if (envUsers.length > 0) {
          console.log(`??Loaded ${envUsers.length} users from environment variable`);
          allUsers.push(...envUsers);
        }
      }

      // 4. If still no users, return empty array (don't throw error)
      if (allUsers.length === 0) {
        console.warn('⚠️ No authorized users found in database, file, or environment variable');
      }

      console.log(`📊 Total loaded users: ${allUsers.length}`);
      console.log('[ConfigStorage] Final user list:', allUsers.map(u => ({ userId: u.userId, email: u.email, canUseBuiltInServices: u.permissions.canUseBuiltInServices })));
      return allUsers;
    } catch (error) {
      console.error('[ConfigStorage] Error loading permissions:', error);
      console.error('[ConfigStorage] Error stack:', error instanceof Error ? error.stack : 'No stack');
      // Return empty array instead of throwing to prevent dashboard crash
      return [];
    }
  }

  /**
   * Load users from AUTHORIZED_USERS environment variable
   */
  private loadUsersFromEnvironment(): AuthorizedUser[] {
    try {
      let envUsersStr = process.env.AUTHORIZED_USERS;
      if (!envUsersStr) {
        return [];
      }

      // Handle escaped quotes in the JSON string
      if (envUsersStr.includes('\\"')) {
        envUsersStr = envUsersStr.replace(/\\"/g, '"');
      }

      const parsed = JSON.parse(envUsersStr);
      if (!Array.isArray(parsed)) {
        console.warn('AUTHORIZED_USERS environment variable must contain an array');
        return [];
      }

      return parsed.map(user => ({
        ...user,
        permissions: {
          ...user.permissions,
          grantedAt: new Date(user.permissions.grantedAt),
        }
      }));
    } catch (error) {
      console.error('Error parsing AUTHORIZED_USERS environment variable:', error);
      return [];
    }
  }


  /**
   * Load users from permissions file
   */
  private async loadUsersFromFile(): Promise<AuthorizedUser[]> {
    try {
      const filePath = join(this.workspaceRoot, CONFIG_PATHS.PERMISSIONS);

      try {
        await fs.access(filePath);
      } catch {
        return [];
      }

      const data = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(data);
      if (!Array.isArray(parsed)) {
        console.warn('Permissions file must contain an array');
        return [];
      }

      return parsed.map(user => ({
        ...user,
        permissions: {
          ...user.permissions,
          grantedAt: new Date(user.permissions.grantedAt),
        }
      }));
    } catch (error) {
      console.error('Error loading permissions file:', error);
      return [];
    }
  }

  /**
   * Save authorized users to storage
   * Saves to database if available, otherwise falls back to file
   */
  async savePermissions(users: AuthorizedUser[]): Promise<void> {
    try {
      const dbAvailable = await this.checkDatabaseAvailability();

      if (dbAvailable) {
        const persistToDb = async () => {
          console.log(`[ConfigStorage] Saving ${users.length} users to database...`);
          for (const user of users) {
            try {
              await saveUserToDatabase(user);
              console.log(`[ConfigStorage] Saved user: ${user.userId}`);
            } catch (userError) {
              console.error(`[ConfigStorage] Failed to save user ${user.userId}:`, userError);
              throw userError;
            }
          }
          console.log(`✅ Saved ${users.length} authorized users to database`);
        };

        try {
          await persistToDb();
        } catch (dbWriteError) {
          const msg = (dbWriteError instanceof Error ? dbWriteError.message : String(dbWriteError || "")).toLowerCase();
          const missingAuthTable =
            msg.includes('relation "authorized_users" does not exist') ||
            msg.includes("relation 'authorized_users' does not exist") ||
            (msg.includes("authorized_users") && msg.includes("does not exist"));
          if (!missingAuthTable) {
            throw dbWriteError;
          }
          console.warn('[ConfigStorage] authorized_users table missing, initializing database and retrying...');
          await initializeDatabase();
          await persistToDb();
        }
      } else {
        // Database not available - fallback to file storage (desktop/local)
        const isServerless = isEphemeralRuntime();
        if (isServerless) {
          console.error('[ConfigStorage] Database not available in serverless environment');
          throw new BuiltInServiceError(
            BuiltInServiceErrorCodes.INVALID_CONFIG,
            'Database not available in serverless environment. Please ensure POSTGRES_URL is configured.'
          );
        }

        const filePath = join(this.workspaceRoot, CONFIG_PATHS.PERMISSIONS);
        await this.ensureDirectoryExists(dirname(filePath));

        const dataToSave = users.map(user => {
          const grantedAt = user.permissions.grantedAt instanceof Date
            ? user.permissions.grantedAt
            : new Date(user.permissions.grantedAt);

          return {
            ...user,
            permissions: {
              ...user.permissions,
              grantedAt: grantedAt.toISOString(),
            }
          };
        });

        await fs.writeFile(filePath, JSON.stringify(dataToSave, null, 2), 'utf-8');
        console.log(`Saved ${users.length} authorized users to ${filePath}`);
      }
    } catch (error) {
      console.error('[ConfigStorage] Error saving permissions:', error);
      throw new BuiltInServiceError(
        BuiltInServiceErrorCodes.INVALID_CONFIG,
        `Failed to save permissions: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Load service configurations from storage
   */
  async loadServiceConfigs(): Promise<BuiltInServiceConfig[]> {
    try {
      const filePath = join(this.workspaceRoot, CONFIG_PATHS.SERVICES);
      
      // Check if file exists
      try {
        await fs.access(filePath);
      } catch {
        // File doesn't exist, return empty array
        console.log('Service configs file not found, returning empty configs');
        return [];
      }

      const data = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(data);

      // Validate and transform the data
      if (!Array.isArray(parsed)) {
        throw new Error('Service configs file must contain an array');
      }

      return parsed.map(config => ({
        ...config,
        createdAt: new Date(config.createdAt),
        updatedAt: new Date(config.updatedAt),
        // API keys are loaded from environment variables, not from storage
        apiKey: this.getApiKeyFromEnvironment(config.provider, config.id)
      }));
    } catch (error) {
      console.error('Error loading service configs:', error);
      throw new BuiltInServiceError(
        BuiltInServiceErrorCodes.INVALID_CONFIG,
        `Failed to load service configs: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Save service configurations to storage
   */
  async saveServiceConfigs(configs: BuiltInServiceConfig[]): Promise<void> {
    try {
      const filePath = join(this.workspaceRoot, CONFIG_PATHS.SERVICES);
      
      // Ensure directory exists
      await this.ensureDirectoryExists(dirname(filePath));

      // Prepare data for serialization (exclude API keys for security)
      const dataToSave = configs.map(config => ({
        ...config,
        apiKey: '***STORED_IN_ENV***', // Don't store actual API keys
        createdAt: config.createdAt.toISOString(),
        updatedAt: config.updatedAt.toISOString(),
      }));

      const jsonData = JSON.stringify(dataToSave, null, 2);
      await fs.writeFile(filePath, jsonData, 'utf-8');

      console.log(`Saved ${configs.length} service configurations to ${filePath}`);
    } catch (error) {
      console.error('Error saving service configs:', error);
      throw new BuiltInServiceError(
        BuiltInServiceErrorCodes.INVALID_CONFIG,
        `Failed to save service configs: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Load user configuration from storage
   */
  async loadUserConfig(userId: string): Promise<UserServiceConfig | null> {
    try {
      const filePath = join(this.workspaceRoot, CONFIG_PATHS.USER_CONFIGS, `${userId}.json`);
      
      // Check if file exists
      try {
        await fs.access(filePath);
      } catch {
        // File doesn't exist
        return null;
      }

      const data = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(data);

      return {
        ...parsed,
        createdAt: new Date(parsed.createdAt),
        updatedAt: new Date(parsed.updatedAt),
      };
    } catch (error) {
      console.error(`Error loading user config for ${userId}:`, error);
      return null;
    }
  }

  /**
   * Save user configuration to storage
   * In serverless environments, user configs are not persisted to file system
   */
  async saveUserConfig(userId: string, config: UserServiceConfig): Promise<void> {
    try {
      // Check if we're in a serverless environment
      const isServerless = isEphemeralRuntime();
      
      if (isServerless) {
        console.log(`[ConfigStorage] Serverless environment - skipping user config file save for ${userId}`);
        // In serverless, user configs are ephemeral and stored in memory only
        // This is acceptable as user service preferences are not critical for core functionality
        return;
      }

      const configDir = join(this.workspaceRoot, CONFIG_PATHS.USER_CONFIGS);
      const filePath = join(configDir, `${userId}.json`);
      
      // Ensure directory exists
      await this.ensureDirectoryExists(configDir);

      // Prepare data for serialization
      const dataToSave = {
        ...config,
        createdAt: config.createdAt.toISOString(),
        updatedAt: config.updatedAt.toISOString(),
      };

      const jsonData = JSON.stringify(dataToSave, null, 2);
      await fs.writeFile(filePath, jsonData, 'utf-8');

      console.log(`Saved user configuration for ${userId}`);
    } catch (error) {
      console.error(`Error saving user config for ${userId}:`, error);
      throw new BuiltInServiceError(
        BuiltInServiceErrorCodes.INVALID_CONFIG,
        `Failed to save user config: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Update user service preferences
   */
  async updateUserPreferences(userId: string, preferences: Partial<UserServiceConfig['preferences']>): Promise<void> {
    try {
      let config = await this.loadUserConfig(userId);
      
      if (!config) {
        // Create new config if it doesn't exist
        config = {
          userId,
          currentServiceType: 'custom',
          preferences: {
            autoSwitchToBuiltIn: false,
            preferredModel: '',
            defaultSize: '1024x1024',
            defaultQuality: 'standard',
            ...preferences
          },
          createdAt: new Date(),
          updatedAt: new Date()
        };
      } else {
        // Update existing config
        config.preferences = {
          ...config.preferences,
          ...preferences
        };
        config.updatedAt = new Date();
      }

      await this.saveUserConfig(userId, config);
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
    duration?: number; // in milliseconds
  }>> {
    try {
      const historyFile = join(this.workspaceRoot, CONFIG_PATHS.USER_CONFIGS, `${userId}-history.json`);
      
      try {
        await fs.access(historyFile);
      } catch {
        return [];
      }

      const data = await fs.readFile(historyFile, 'utf-8');
      const parsed = JSON.parse(data);

      return parsed.map((entry: any) => ({
        ...entry,
        switchedAt: new Date(entry.switchedAt)
      }));
    } catch (error) {
      console.error(`Error loading service history for ${userId}:`, error);
      return [];
    }
  }

  /**
   * Record service switch in user history
   * In serverless environments, history is not persisted
   */
  async recordServiceSwitch(userId: string, serviceId: string, serviceType: 'built-in' | 'custom'): Promise<void> {
    try {
      // Check if we're in a serverless environment
      const isServerless = isEphemeralRuntime();
      
      if (isServerless) {
        console.log(`[ConfigStorage] Serverless environment - skipping service switch history for ${userId}`);
        // In serverless, service history is not persisted (non-critical feature)
        return;
      }

      const history = await this.getUserServiceHistory(userId);
      const now = new Date();
      
      // Calculate duration of previous service usage
      if (history.length > 0) {
        const lastEntry = history[history.length - 1];
        lastEntry.duration = now.getTime() - lastEntry.switchedAt.getTime();
      }

      // Add new entry
      history.push({
        serviceId,
        serviceType,
        switchedAt: now
      });

      // Keep only last 50 entries
      const recentHistory = history.slice(-50);

      const historyFile = join(this.workspaceRoot, CONFIG_PATHS.USER_CONFIGS, `${userId}-history.json`);
      const dataToSave = recentHistory.map(entry => ({
        ...entry,
        switchedAt: entry.switchedAt.toISOString()
      }));

      await fs.writeFile(historyFile, JSON.stringify(dataToSave, null, 2), 'utf-8');
      console.log(`Recorded service switch for user ${userId}: ${serviceType}/${serviceId}`);
    } catch (error) {
      console.error(`Error recording service switch for ${userId}:`, error);
      // Don't throw error here as this is not critical functionality
    }
  }

  /**
   * Get user configuration statistics
   */
  async getUserConfigStats(userId: string): Promise<{
    totalSwitches: number;
    builtInUsageTime: number;
    customUsageTime: number;
    preferredService: 'built-in' | 'custom';
    lastActivity: Date | null;
    configCreated: Date | null;
  }> {
    try {
      const config = await this.loadUserConfig(userId);
      const history = await this.getUserServiceHistory(userId);

      let builtInUsageTime = 0;
      let customUsageTime = 0;

      history.forEach(entry => {
        if (entry.duration) {
          if (entry.serviceType === 'built-in') {
            builtInUsageTime += entry.duration;
          } else {
            customUsageTime += entry.duration;
          }
        }
      });

      const preferredService = builtInUsageTime > customUsageTime ? 'built-in' : 'custom';
      const lastActivity = history.length > 0 ? history[history.length - 1].switchedAt : null;

      return {
        totalSwitches: history.length,
        builtInUsageTime,
        customUsageTime,
        preferredService,
        lastActivity,
        configCreated: config?.createdAt || null
      };
    } catch (error) {
      console.error(`Error getting config stats for ${userId}:`, error);
      return {
        totalSwitches: 0,
        builtInUsageTime: 0,
        customUsageTime: 0,
        preferredService: 'custom',
        lastActivity: null,
        configCreated: null
      };
    }
  }

  /**
   * Clean up old user configurations
   */
  async cleanupOldUserConfigs(maxAgeInDays: number = 90): Promise<number> {
    try {
      const configDir = join(this.workspaceRoot, CONFIG_PATHS.USER_CONFIGS);
      
      try {
        await fs.access(configDir);
      } catch {
        return 0;
      }

      const files = await fs.readdir(configDir);
      const cutoffDate = new Date(Date.now() - maxAgeInDays * 24 * 60 * 60 * 1000);
      let cleanedCount = 0;

      for (const file of files) {
        if (file.endsWith('.json') && !file.endsWith('-history.json')) {
          const filePath = join(configDir, file);
          const stats = await fs.stat(filePath);
          
          // Check if file is older than cutoff and hasn't been modified recently
          if (stats.mtime < cutoffDate) {
            const userId = file.replace('.json', '');
            const config = await this.loadUserConfig(userId);
            
            // Only delete if user hasn't been active recently
            if (config && config.updatedAt < cutoffDate) {
              await fs.unlink(filePath);
              
              // Also clean up history file
              const historyFile = join(configDir, `${userId}-history.json`);
              try {
                await fs.unlink(historyFile);
              } catch {
                // Ignore if history file doesn't exist
              }
              
              cleanedCount++;
              console.log(`Cleaned up old config for user: ${userId}`);
            }
          }
        }
      }

      console.log(`Cleaned up ${cleanedCount} old user configurations`);
      return cleanedCount;
    } catch (error) {
      console.error('Error cleaning up old user configs:', error);
      return 0;
    }
  }

  /**
   * Create backup of all configurations
   */
  async createBackup(): Promise<string> {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupDir = join(this.workspaceRoot, CONFIG_PATHS.BACKUPS);
      const backupFile = join(backupDir, `backup-${timestamp}.json`);
      
      // Ensure backup directory exists
      await this.ensureDirectoryExists(backupDir);

      // Collect all configuration data
      const backupData = {
        timestamp: new Date().toISOString(),
        permissions: await this.loadPermissions().catch(() => []),
        serviceConfigs: await this.loadServiceConfigs().catch(() => []),
        userConfigs: await this.loadAllUserConfigs(),
        version: '1.0.0'
      };

      const jsonData = JSON.stringify(backupData, null, 2);
      await fs.writeFile(backupFile, jsonData, 'utf-8');

      console.log(`Created backup: ${backupFile}`);
      return backupFile;
    } catch (error) {
      console.error('Error creating backup:', error);
      throw new BuiltInServiceError(
        BuiltInServiceErrorCodes.INVALID_CONFIG,
        `Failed to create backup: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Restore from backup
   */
  async restoreFromBackup(backupData: string): Promise<void> {
    try {
      const parsed = JSON.parse(backupData);
      
      // Validate backup data structure
      if (!parsed.timestamp || !parsed.version) {
        throw new Error('Invalid backup data format');
      }

      // Restore permissions
      if (parsed.permissions && Array.isArray(parsed.permissions)) {
        await this.savePermissions(parsed.permissions);
      }

      // Restore service configs
      if (parsed.serviceConfigs && Array.isArray(parsed.serviceConfigs)) {
        await this.saveServiceConfigs(parsed.serviceConfigs);
      }

      // Restore user configs
      if (parsed.userConfigs && typeof parsed.userConfigs === 'object') {
        for (const [userId, config] of Object.entries(parsed.userConfigs)) {
          await this.saveUserConfig(userId, config as UserServiceConfig);
        }
      }

      console.log(`Restored configuration from backup (${parsed.timestamp})`);
    } catch (error) {
      console.error('Error restoring from backup:', error);
      throw new BuiltInServiceError(
        BuiltInServiceErrorCodes.INVALID_CONFIG,
        `Failed to restore from backup: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get API key from environment variables
   */
  private getApiKeyFromEnvironment(provider: string, serviceId: string): string {
    // Try service-specific environment variable first
    const serviceSpecificKey = `${serviceId.toUpperCase().replace(/-/g, '_')}_API_KEY`;
    let apiKey = process.env[serviceSpecificKey];
    
    if (apiKey) {
      return apiKey;
    }

    // Fall back to provider-specific environment variables
    switch (provider.toLowerCase()) {
      case 'gemini':
        return process.env[ENV_KEYS.GEMINI_BUILT_IN_API_KEY] || '';
      case 'openai':
        return process.env[ENV_KEYS.OPENAI_BUILT_IN_API_KEY] || '';
      case 'claude':
        return process.env[ENV_KEYS.CLAUDE_BUILT_IN_API_KEY] || '';
      default:
        console.warn(`Unknown provider: ${provider}, no API key available`);
        return '';
    }
  }

  /**
   * Ensure directory exists
   */
  private async ensureDirectoryExists(dirPath: string): Promise<void> {
    try {
      await fs.mkdir(dirPath, { recursive: true });
    } catch (error) {
      // Ignore error if directory already exists
      if ((error as any)?.code !== 'EEXIST') {
        throw error;
      }
    }
  }

  /**
   * Load all user configurations
   */
  private async loadAllUserConfigs(): Promise<Record<string, UserServiceConfig>> {
    try {
      const configDir = join(this.workspaceRoot, CONFIG_PATHS.USER_CONFIGS);
      
      // Check if directory exists
      try {
        await fs.access(configDir);
      } catch {
        return {};
      }

      const files = await fs.readdir(configDir);
      const userConfigs: Record<string, UserServiceConfig> = {};

      for (const file of files) {
        if (file.endsWith('.json')) {
          const userId = file.replace('.json', '');
          const config = await this.loadUserConfig(userId);
          if (config) {
            userConfigs[userId] = config;
          }
        }
      }

      return userConfigs;
    } catch (error) {
      console.error('Error loading all user configs:', error);
      return {};
    }
  }

  /**
   * Validate environment variables
   */
  validateEnvironmentVariables(): {
    isValid: boolean;
    missingKeys: string[];
    availableServices: string[];
  } {
    const missingKeys: string[] = [];
    const availableServices: string[] = [];

    // Check for built-in service API keys
    Object.entries(ENV_KEYS).forEach(([keyName, envVar]) => {
      if (process.env[envVar]) {
        const provider = keyName.replace('_BUILT_IN_API_KEY', '').toLowerCase();
        availableServices.push(provider);
      } else {
        missingKeys.push(envVar);
      }
    });

    return {
      isValid: availableServices.length > 0,
      missingKeys,
      availableServices
    };
  }

  /**
   * Get configuration file paths
   */
  getConfigurationPaths(): {
    permissions: string;
    services: string;
    userConfigs: string;
    backups: string;
  } {
    return {
      permissions: join(this.workspaceRoot, CONFIG_PATHS.PERMISSIONS),
      services: join(this.workspaceRoot, CONFIG_PATHS.SERVICES),
      userConfigs: join(this.workspaceRoot, CONFIG_PATHS.USER_CONFIGS),
      backups: join(this.workspaceRoot, CONFIG_PATHS.BACKUPS)
    };
  }

  /**
   * Check if configuration files exist
   */
  async checkConfigurationFiles(): Promise<{
    permissions: boolean;
    services: boolean;
    userConfigsDir: boolean;
    backupsDir: boolean;
  }> {
    const paths = this.getConfigurationPaths();
    
    const checkFile = async (path: string): Promise<boolean> => {
      try {
        await fs.access(path);
        return true;
      } catch {
        return false;
      }
    };

    return {
      permissions: await checkFile(paths.permissions),
      services: await checkFile(paths.services),
      userConfigsDir: await checkFile(paths.userConfigs),
      backupsDir: await checkFile(paths.backups)
    };
  }

  /**
   * Initialize configuration directories
   * In serverless environments (Vercel), skip file system initialization
   */
  async initializeConfigurationDirectories(): Promise<void> {
    try {
      // Check if we're in a serverless environment (Vercel)
      const isServerless = isEphemeralRuntime();
      
      if (isServerless) {
        console.log('[ConfigStorage] Running in serverless environment - skipping file system initialization');
        // In serverless, we rely entirely on database storage
        const dbAvailable = await this.checkDatabaseAvailability();
        if (!dbAvailable) {
          throw new BuiltInServiceError(
            BuiltInServiceErrorCodes.INVALID_CONFIG,
            'Database not available in serverless environment. Please ensure POSTGRES_URL is configured.'
          );
        }
        console.log('[ConfigStorage] Database is available - ready to use');
        return;
      }

      // Only create directories in non-serverless environments
      const paths = this.getConfigurationPaths();
      
      await this.ensureDirectoryExists(dirname(paths.permissions));
      await this.ensureDirectoryExists(dirname(paths.services));
      await this.ensureDirectoryExists(paths.userConfigs);
      await this.ensureDirectoryExists(paths.backups);

      console.log('Configuration directories initialized');
    } catch (error) {
      console.error('Error initializing configuration directories:', error);
      throw new BuiltInServiceError(
        BuiltInServiceErrorCodes.INVALID_CONFIG,
        `Failed to initialize configuration directories: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  // ========== CONFIGURATION MIGRATION AND COMPATIBILITY ==========

  /**
   * Migrate configuration from older versions
   */
  async migrateConfiguration(): Promise<{
    migrated: boolean;
    fromVersion: string;
    toVersion: string;
    changes: string[];
  }> {
    try {
      const migrationResult = {
        migrated: false,
        fromVersion: 'unknown',
        toVersion: '1.0.0',
        changes: [] as string[]
      };

      // Check for legacy configuration files
      const legacyMigrations = await this.migrateLegacyConfigurations();
      if (legacyMigrations.migrated) {
        migrationResult.migrated = true;
        migrationResult.fromVersion = legacyMigrations.fromVersion;
        migrationResult.changes.push(...legacyMigrations.changes);
      }

      // Check for version-specific migrations
      const versionMigrations = await this.migrateVersionSpecificChanges();
      if (versionMigrations.migrated) {
        migrationResult.migrated = true;
        migrationResult.changes.push(...versionMigrations.changes);
      }

      // Ensure backward compatibility
      await this.ensureBackwardCompatibility();
      migrationResult.changes.push('Ensured backward compatibility');

      if (migrationResult.migrated) {
        console.log(`Configuration migrated from ${migrationResult.fromVersion} to ${migrationResult.toVersion}`);
        console.log('Migration changes:', migrationResult.changes);
      }

      return migrationResult;
    } catch (error) {
      console.error('Error during configuration migration:', error);
      throw new BuiltInServiceError(
        BuiltInServiceErrorCodes.INVALID_CONFIG,
        `Configuration migration failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Migrate legacy configuration files
   */
  private async migrateLegacyConfigurations(): Promise<{
    migrated: boolean;
    fromVersion: string;
    changes: string[];
  }> {
    const changes: string[] = [];
    let migrated = false;
    let fromVersion = 'unknown';

    try {
      // Check for old API key storage in different locations
      const legacyApiKeyFile = join(this.workspaceRoot, '.env.local');
      try {
        await fs.access(legacyApiKeyFile);
        const envContent = await fs.readFile(legacyApiKeyFile, 'utf-8');
        
        // Look for built-in service API keys in .env.local
        const builtInKeys = this.extractBuiltInKeysFromEnv(envContent);
        if (builtInKeys.length > 0) {
          changes.push(`Found ${builtInKeys.length} built-in API keys in .env.local`);
          changes.push('Built-in API keys should be configured as environment variables');
          migrated = true;
          fromVersion = 'pre-1.0.0';
        }
      } catch {
        // .env.local doesn't exist, which is fine
      }

      // Check for old user configuration format
      const userConfigsDir = join(this.workspaceRoot, CONFIG_PATHS.USER_CONFIGS);
      try {
        const files = await fs.readdir(userConfigsDir);
        for (const file of files) {
          if (file.endsWith('.json') && !file.endsWith('-history.json')) {
            const filePath = join(userConfigsDir, file);
            const content = await fs.readFile(filePath, 'utf-8');
            const config = JSON.parse(content);
            
            // Check if this is an old format that needs migration
            if (await this.needsUserConfigMigration(config)) {
              const migratedConfig = await this.migrateUserConfig(config);
              await fs.writeFile(filePath, JSON.stringify(migratedConfig, null, 2), 'utf-8');
              changes.push(`Migrated user configuration: ${file}`);
              migrated = true;
              fromVersion = 'pre-1.0.0';
            }
          }
        }
      } catch {
        // User configs directory doesn't exist yet
      }

      return { migrated, fromVersion, changes };
    } catch (error) {
      console.error('Error migrating legacy configurations:', error);
      return { migrated: false, fromVersion: 'unknown', changes: [] };
    }
  }

  /**
   * Migrate version-specific changes
   */
  private async migrateVersionSpecificChanges(): Promise<{
    migrated: boolean;
    changes: string[];
  }> {
    const changes: string[] = [];
    let migrated = false;

    try {
      // Check current version from a version file
      const versionFile = join(this.workspaceRoot, CONFIG_PATHS.USER_CONFIGS, '.version');
      let currentVersion = '0.0.0';
      
      try {
        currentVersion = (await fs.readFile(versionFile, 'utf-8')).trim();
      } catch {
        // Version file doesn't exist, assume first installation
        await fs.writeFile(versionFile, '1.0.0', 'utf-8');
        changes.push('Created version file');
        migrated = true;
      }

      // Perform version-specific migrations
      if (this.compareVersions(currentVersion, '1.0.0') < 0) {
        // Migrate to 1.0.0
        await this.migrateTo1_0_0();
        changes.push('Migrated to version 1.0.0');
        migrated = true;
      }

      // Update version file if migrations were performed
      if (migrated) {
        await fs.writeFile(versionFile, '1.0.0', 'utf-8');
      }

      return { migrated, changes };
    } catch (error) {
      console.error('Error in version-specific migrations:', error);
      return { migrated: false, changes: [] };
    }
  }

  /**
   * Ensure backward compatibility with existing systems
   */
  private async ensureBackwardCompatibility(): Promise<void> {
    try {
      // Ensure that existing users without built-in service configurations
      // can still use the system with custom API configurations
      
      // Create default service configurations if they don't exist
      const serviceConfigs = await this.loadServiceConfigs().catch(() => []);
      if (serviceConfigs.length === 0) {
        const defaultConfigs = this.createDefaultServiceConfigs();
        await this.saveServiceConfigs(defaultConfigs);
        console.log('Created default service configurations for backward compatibility');
      }

      // Ensure permissions file exists with empty array if no permissions are set
      const permissions = await this.loadPermissions().catch(() => []);
      if (permissions.length === 0) {
        await this.savePermissions([]);
        console.log('Created empty permissions file for backward compatibility');
      }

    } catch (error) {
      console.error('Error ensuring backward compatibility:', error);
      // Don't throw error here as this is not critical for system operation
    }
  }

  /**
   * Extract built-in API keys from environment content
   */
  private extractBuiltInKeysFromEnv(envContent: string): string[] {
    const keys: string[] = [];
    const lines = envContent.split('\n');
    
    for (const line of lines) {
      if (line.includes('BUILT_IN_API_KEY') || line.includes('BUILTIN_API_KEY')) {
        keys.push(line.trim());
      }
    }
    
    return keys;
  }

  /**
   * Check if user config needs migration
   */
  private async needsUserConfigMigration(config: any): Promise<boolean> {
    // Check for old format indicators
    if (!config.userId || !config.currentServiceType) {
      return true;
    }
    
    // Check if preferences structure is old
    if (config.preferences && typeof config.preferences.autoSwitchToBuiltIn === 'undefined') {
      return true;
    }
    
    // Check if dates are in old format
    if (config.createdAt && typeof config.createdAt === 'string' && !config.createdAt.includes('T')) {
      return true;
    }
    
    return false;
  }

  /**
   * Migrate user configuration to new format
   */
  private async migrateUserConfig(oldConfig: any): Promise<UserServiceConfig> {
    const now = new Date();
    
    return {
      userId: oldConfig.userId || 'unknown',
      currentServiceType: oldConfig.currentServiceType || 'custom',
      builtInServiceId: oldConfig.builtInServiceId,
      customConfig: oldConfig.customConfig,
      preferences: {
        autoSwitchToBuiltIn: oldConfig.preferences?.autoSwitchToBuiltIn ?? false,
        preferredModel: oldConfig.preferences?.preferredModel || '',
        defaultSize: oldConfig.preferences?.defaultSize || '1024x1024',
        defaultQuality: oldConfig.preferences?.defaultQuality || 'standard'
      },
      createdAt: oldConfig.createdAt ? new Date(oldConfig.createdAt) : now,
      updatedAt: oldConfig.updatedAt ? new Date(oldConfig.updatedAt) : now
    };
  }

  /**
   * Migrate to version 1.0.0
   */
  private async migrateTo1_0_0(): Promise<void> {
    // Add any specific migrations needed for version 1.0.0
    console.log('Performing migration to version 1.0.0');
    
    // Example: Ensure all user configs have the new preferences structure
    const userConfigsDir = join(this.workspaceRoot, CONFIG_PATHS.USER_CONFIGS);
    try {
      const files = await fs.readdir(userConfigsDir);
      for (const file of files) {
        if (file.endsWith('.json') && !file.endsWith('-history.json')) {
          const userId = file.replace('.json', '');
          const config = await this.loadUserConfig(userId);
          if (config) {
            // Ensure preferences have all required fields
            config.preferences = {
              autoSwitchToBuiltIn: config.preferences?.autoSwitchToBuiltIn ?? false,
              preferredModel: config.preferences?.preferredModel || '',
              defaultSize: config.preferences?.defaultSize || '1024x1024',
              defaultQuality: config.preferences?.defaultQuality || 'standard'
            };
            await this.saveUserConfig(userId, config);
          }
        }
      }
    } catch {
      // Directory doesn't exist yet, which is fine
    }
  }

  /**
   * Compare version strings
   */
  private compareVersions(version1: string, version2: string): number {
    const v1Parts = version1.split('.').map(Number);
    const v2Parts = version2.split('.').map(Number);
    
    for (let i = 0; i < Math.max(v1Parts.length, v2Parts.length); i++) {
      const v1Part = v1Parts[i] || 0;
      const v2Part = v2Parts[i] || 0;
      
      if (v1Part < v2Part) return -1;
      if (v1Part > v2Part) return 1;
    }
    
    return 0;
  }

  /**
   * Create default service configurations
   */
  private createDefaultServiceConfigs(): BuiltInServiceConfig[] {
    const now = new Date();
    
    return [
      {
        id: 'gemini-built-in',
        name: 'Built-in Gemini Service',
        provider: 'gemini',
        apiKey: '', // Will be loaded from environment
        baseUrl: 'https://generativelanguage.googleapis.com/v1',
        model: 'gemini-1.5-flash',
        isEnabled: true,
        quotaLimits: {
          dailyRequests: 50,
          monthlyRequests: 1000,
          concurrentRequests: 3
        },
        rateLimits: {
          requestsPerMinute: 10,
          requestsPerHour: 100,
          burstLimit: 5
        },
        createdAt: now,
        updatedAt: now
      }
    ];
  }

  /**
   * Validate configuration integrity
   */
  async validateConfigurationIntegrity(): Promise<{
    isValid: boolean;
    issues: string[];
    recommendations: string[];
  }> {
    const issues: string[] = [];
    const recommendations: string[] = [];

    try {
      // Check permissions file
      try {
        const permissions = await this.loadPermissions();
        if (permissions.some(user => !user.userId || !user.permissions)) {
          issues.push('Invalid user permissions found');
        }
      } catch (error) {
        issues.push('Cannot load permissions file');
      }

      // Check service configurations
      try {
        const services = await this.loadServiceConfigs();
        if (services.some(service => !service.id || !service.provider)) {
          issues.push('Invalid service configurations found');
        }
      } catch (error) {
        issues.push('Cannot load service configurations');
      }

      // Check environment variables
      const envValidation = this.validateEnvironmentVariables();
      if (!envValidation.isValid) {
        recommendations.push('Consider setting up built-in API keys in environment variables');
      }

      // Check for orphaned user configurations
      const userConfigs = await this.loadAllUserConfigs();
      const orphanedConfigs = Object.keys(userConfigs).filter(userId => {
        const config = userConfigs[userId];
        return !config.userId || config.userId !== userId;
      });
      
      if (orphanedConfigs.length > 0) {
        issues.push(`Found ${orphanedConfigs.length} orphaned user configurations`);
        recommendations.push('Run cleanup to remove orphaned configurations');
      }

      return {
        isValid: issues.length === 0,
        issues,
        recommendations
      };
    } catch (error) {
      return {
        isValid: false,
        issues: [`Configuration validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`],
        recommendations: ['Check file permissions and directory structure']
      };
    }
  }
}
