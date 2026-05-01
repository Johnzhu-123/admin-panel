/**
 * Database utilities for Vercel Postgres
 * Handles database connection and table initialization
 */

import { sql } from '@vercel/postgres';
import { AuthorizedUser } from './types';
import { encryptSecret, decryptSecret, maskSecret } from './encryption';

/**
 * 7 大类内置服务（实际暴露 5 个 catalog 项，对应 7 个字段角色：
 * 多模态/文本/图像 AI + 配音 TTS + 视频 AI；BaseURL 与 API Key 为每类独立维护）
 */
export const BUILT_IN_SERVICE_CATEGORIES = [
  'multimodal',
  'text',
  'image',
  'tts',
  'video',
] as const;

export type BuiltInServiceCategory = (typeof BUILT_IN_SERVICE_CATEGORIES)[number];

export interface BuiltInServiceCategoryConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  isEnabled: boolean;
  updatedAt?: string;
}

export type BuiltInServiceCatalog = Record<BuiltInServiceCategory, BuiltInServiceCategoryConfig>;

const DEFAULT_CATEGORY_CONFIG: BuiltInServiceCategoryConfig = {
  baseUrl: '',
  apiKey: '',
  model: '',
  isEnabled: false,
};

const SERVICE_CATALOG_SETTING_KEY_PREFIX = 'service_catalog_';

const SERVICE_CATEGORY_DEFAULT_MODEL: Record<BuiltInServiceCategory, string> = {
  multimodal: 'gpt-4o-mini',
  text: 'gpt-4o-mini',
  image: 'gpt-image-1',
  tts: 'tts-1',
  video: 'sora-1',
};

function makeEmptyCatalog(): BuiltInServiceCatalog {
  return BUILT_IN_SERVICE_CATEGORIES.reduce((acc, key) => {
    acc[key] = {
      ...DEFAULT_CATEGORY_CONFIG,
      model: SERVICE_CATEGORY_DEFAULT_MODEL[key],
    };
    return acc;
  }, {} as BuiltInServiceCatalog);
}

function normalizeCategoryInput(
  category: BuiltInServiceCategory,
  raw: unknown
): BuiltInServiceCategoryConfig {
  const fallbackModel = SERVICE_CATEGORY_DEFAULT_MODEL[category];
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_CATEGORY_CONFIG, model: fallbackModel };
  }
  const record = raw as Record<string, unknown>;
  const baseUrl = String(record.baseUrl || '').trim().replace(/\/+$/, '');
  const apiKey = typeof record.apiKey === 'string' ? record.apiKey : '';
  const model = String(record.model || '').trim() || fallbackModel;
  const isEnabled = record.isEnabled === true || record.isEnabled === 'true';
  return { baseUrl, apiKey, model, isEnabled };
}

let ensuringAuthorizedUsersTable: Promise<void> | null = null;

async function ensureAuthorizedUsersTable(): Promise<void> {
  if (ensuringAuthorizedUsersTable) {
    return ensuringAuthorizedUsersTable;
  }
  ensuringAuthorizedUsersTable = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS authorized_users (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) UNIQUE NOT NULL,
        email VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        status VARCHAR(50) DEFAULT 'active',
        can_use_built_in_services BOOLEAN DEFAULT true,
        allowed_services TEXT[],
        daily_requests INTEGER DEFAULT 500,
        monthly_requests INTEGER DEFAULT 15000,
        concurrent_requests INTEGER DEFAULT 20,
        granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        granted_by VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS idx_user_id ON authorized_users(user_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_status ON authorized_users(status)`;
  })();
  try {
    await ensuringAuthorizedUsersTable;
  } finally {
    ensuringAuthorizedUsersTable = null;
  }
}

/**
 * Check if database is available
 */
export async function isDatabaseAvailable(): Promise<boolean> {
  try {
    if (process.env.ELECTRON_DESKTOP === "1" && process.env.ELECTRON_ALLOW_DATABASE !== "1") {
      console.log('Database disabled in desktop mode (ELECTRON_ALLOW_DATABASE not set)');
      return false;
    }

    // Check if POSTGRES_URL is configured
    if (!process.env.POSTGRES_URL && !process.env.POSTGRES_PRISMA_URL) {
      console.log('Database not configured (no POSTGRES_URL)');
      return false;
    }

    // Try a simple query with timeout
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Database connection timeout')), 12000)
    );
    
    const queryPromise = sql`SELECT 1`;
    
    await Promise.race([queryPromise, timeoutPromise]);
    return true;
  } catch (error) {
    console.log('Database not available:', error instanceof Error ? error.message : 'Unknown error');
    return false;
  }
}

/**
 * Initialize database tables
 */
export async function initializeDatabase(): Promise<void> {
  try {
    console.log('Initializing database tables...');

    await ensureAuthorizedUsersTable();

    // Initialize image generation tasks table
    await initializeImageTasksTable();

    // Initialize usage tracking table
    await initializeUsageTrackingTable();

    // Initialize terms acceptance table
    await initializeTermsAcceptanceTable();

    // Initialize runtime settings table
    await initializeSystemSettingsTable();

    console.log('✅ Database tables initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize database:', error);
    throw error;
  }
}

/**
 * Initialize system settings table
 */
export async function initializeSystemSettingsTable(): Promise<void> {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS built_in_system_settings (
        setting_key VARCHAR(120) PRIMARY KEY,
        setting_value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
  } catch (error) {
    console.error('Failed to initialize built_in_system_settings table:', error);
    throw error;
  }
}

export type BuiltInRuntimeSettings = {
  serviceGatewayUrl: string;
  iopaintUrls: string[];
  updatePageUrl: string;
  downloadChannels: Array<{
    id: string;
    name: string;
    url: string;
  }>;
  serviceCatalog: BuiltInServiceCatalog;
};

const normalizeUrl = (value?: string) => (value || '').trim().replace(/\/+$/, '');
const normalizeChannelId = (value?: string) =>
  (value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
const normalizeChannelName = (value?: string) => (value || '').trim().slice(0, 40);

const parseIopaintUrls = (value?: string | null) =>
  (value || '')
    .split(/[\n,;]/)
    .map((item) => normalizeUrl(item))
    .filter((item) => /^https?:\/\//i.test(item));

const parseDownloadChannels = (
  raw: unknown
): Array<{ id: string; name: string; url: string }> => {
  const normalizeFromArray = (arr: unknown[]) => {
    const dedupe = new Set<string>();
    const list: Array<{ id: string; name: string; url: string }> = [];
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const url = normalizeUrl(String(record.url || ''));
      if (!/^https?:\/\//i.test(url)) continue;
      const id = normalizeChannelId(String(record.id || '')) || `link_${list.length + 1}`;
      const name = normalizeChannelName(String(record.name || '')) || id;
      const key = `${id}|${url}`;
      if (dedupe.has(key)) continue;
      dedupe.add(key);
      list.push({ id, name, url });
    }
    return list;
  };

  if (Array.isArray(raw)) return normalizeFromArray(raw);
  if (typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return normalizeFromArray(parsed);
    return [];
  } catch {
    return [];
  }
};

export async function getSystemSetting(settingKey: string): Promise<string | null> {
  try {
    const { rows } = await sql`
      SELECT setting_value
      FROM built_in_system_settings
      WHERE setting_key = ${settingKey}
      LIMIT 1
    `;
    return rows[0]?.setting_value ?? null;
  } catch (error) {
    console.error(`Failed to read system setting ${settingKey}:`, error);
    return null;
  }
}

export async function setSystemSetting(settingKey: string, settingValue: string): Promise<void> {
  await sql`
    INSERT INTO built_in_system_settings (setting_key, setting_value, updated_at)
    VALUES (${settingKey}, ${settingValue}, CURRENT_TIMESTAMP)
    ON CONFLICT (setting_key)
    DO UPDATE SET
      setting_value = EXCLUDED.setting_value,
      updated_at = CURRENT_TIMESTAMP
  `;
}

async function loadServiceCatalog(): Promise<BuiltInServiceCatalog> {
  const catalog = makeEmptyCatalog();
  try {
    const records = await Promise.all(
      BUILT_IN_SERVICE_CATEGORIES.map((category) =>
        getSystemSetting(`${SERVICE_CATALOG_SETTING_KEY_PREFIX}${category}`)
      )
    );
    BUILT_IN_SERVICE_CATEGORIES.forEach((category, index) => {
      const raw = records[index];
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        catalog[category] = {
          baseUrl: String(parsed.baseUrl || '').trim().replace(/\/+$/, ''),
          apiKey: typeof parsed.apiKey === 'string' ? decryptSecret(parsed.apiKey) : '',
          model: String(parsed.model || '').trim() || SERVICE_CATEGORY_DEFAULT_MODEL[category],
          isEnabled: parsed.isEnabled === true,
          updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
        };
      } catch (error) {
        console.warn(`[serviceCatalog] 解析 ${category} 配置失败:`, error);
      }
    });
  } catch (error) {
    console.error('[serviceCatalog] 加载失败:', error);
  }
  return catalog;
}

async function persistServiceCatalog(catalog: BuiltInServiceCatalog): Promise<void> {
  await Promise.all(
    BUILT_IN_SERVICE_CATEGORIES.map((category) => {
      const cfg = catalog[category];
      const payload = {
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey ? encryptSecret(cfg.apiKey) : '',
        model: cfg.model,
        isEnabled: cfg.isEnabled,
        updatedAt: new Date().toISOString(),
      };
      return setSystemSetting(
        `${SERVICE_CATALOG_SETTING_KEY_PREFIX}${category}`,
        JSON.stringify(payload)
      );
    })
  );
}

export async function getServiceCatalog(): Promise<BuiltInServiceCatalog> {
  await initializeSystemSettingsTable();
  return loadServiceCatalog();
}

export async function setServiceCategoryConfig(
  category: BuiltInServiceCategory,
  patch: Partial<BuiltInServiceCategoryConfig>
): Promise<BuiltInServiceCategoryConfig> {
  await initializeSystemSettingsTable();
  const current = await loadServiceCatalog();
  const next = normalizeCategoryInput(category, { ...current[category], ...patch });
  if (patch.apiKey === undefined) {
    next.apiKey = current[category].apiKey;
  }
  current[category] = next;
  await persistServiceCatalog(current);
  return next;
}

export function sanitizeServiceCatalog(
  catalog: BuiltInServiceCatalog,
  options: { includeKeyMask?: boolean } = {}
): BuiltInServiceCatalog {
  const out = makeEmptyCatalog();
  for (const category of BUILT_IN_SERVICE_CATEGORIES) {
    const cfg = catalog[category];
    out[category] = {
      baseUrl: cfg.baseUrl,
      apiKey: options.includeKeyMask && cfg.apiKey ? maskSecret(cfg.apiKey) : '',
      model: cfg.model,
      isEnabled: cfg.isEnabled,
      updatedAt: cfg.updatedAt,
    };
  }
  return out;
}

export async function getBuiltInRuntimeSettings(): Promise<BuiltInRuntimeSettings> {
  const envGateway = normalizeUrl(
    process.env.BUILT_IN_SERVICE_SERVER_URL ||
      process.env.NEXT_PUBLIC_BUILT_IN_SERVICE_SERVER_URL ||
      'https://ppt2admin.zeabur.app'
  );
  const envUpdatePageUrl = normalizeUrl(
    process.env.BUILT_IN_RELEASE_PAGE_URL ||
      process.env.NEXT_PUBLIC_BUILT_IN_RELEASE_PAGE_URL ||
      ''
  );
  const envIopaintRaw =
    process.env.BUILT_IN_IOPAINT_URL ||
    process.env.NEXT_PUBLIC_BUILT_IN_IOPAINT_URL ||
    '';
  const envDownloadChannelsRaw =
    process.env.BUILT_IN_DOWNLOAD_CHANNELS ||
    process.env.NEXT_PUBLIC_BUILT_IN_DOWNLOAD_CHANNELS ||
    '';
  const envIopaintUrls = parseIopaintUrls(envIopaintRaw);
  const envDownloadChannels = parseDownloadChannels(envDownloadChannelsRaw);

  try {
    await initializeSystemSettingsTable();
    const [gatewayValue, iopaintValue, updatePageValue, downloadChannelsValue, serviceCatalog] = await Promise.all([
      getSystemSetting('service_gateway_url'),
      getSystemSetting('iopaint_urls'),
      getSystemSetting('update_page_url'),
      getSystemSetting('download_channels'),
      loadServiceCatalog(),
    ]);

    let iopaintUrls = envIopaintUrls;
    let updatePageUrl = envUpdatePageUrl;
    let downloadChannels = envDownloadChannels;
    if (iopaintValue) {
      try {
        const parsed = JSON.parse(iopaintValue);
        if (Array.isArray(parsed)) {
          iopaintUrls = parsed
            .map((item) => normalizeUrl(String(item || '')))
            .filter((item) => /^https?:\/\//i.test(item));
        } else {
          iopaintUrls = parseIopaintUrls(iopaintValue);
        }
      } catch {
        iopaintUrls = parseIopaintUrls(iopaintValue);
      }
    }
    if (updatePageValue) {
      const parsed = normalizeUrl(updatePageValue);
      if (/^https?:\/\//i.test(parsed)) {
        updatePageUrl = parsed;
      } else {
        updatePageUrl = '';
      }
    }
    if (downloadChannelsValue) {
      downloadChannels = parseDownloadChannels(downloadChannelsValue);
    }

    return {
      serviceGatewayUrl: normalizeUrl(gatewayValue || envGateway),
      iopaintUrls,
      updatePageUrl,
      downloadChannels,
      serviceCatalog,
    };
  } catch {
    return {
      serviceGatewayUrl: envGateway,
      iopaintUrls: envIopaintUrls,
      updatePageUrl: envUpdatePageUrl,
      downloadChannels: envDownloadChannels,
      serviceCatalog: makeEmptyCatalog(),
    };
  }
}

export async function saveBuiltInRuntimeSettings(input: Partial<BuiltInRuntimeSettings>): Promise<BuiltInRuntimeSettings> {
  await initializeSystemSettingsTable();
  const current = await getBuiltInRuntimeSettings();

  let mergedCatalog = current.serviceCatalog;
  if (input.serviceCatalog && typeof input.serviceCatalog === 'object') {
    mergedCatalog = { ...current.serviceCatalog };
    for (const category of BUILT_IN_SERVICE_CATEGORIES) {
      const incoming = (input.serviceCatalog as Partial<BuiltInServiceCatalog>)[category];
      if (incoming === undefined) continue;
      const next = normalizeCategoryInput(category, { ...current.serviceCatalog[category], ...incoming });
      if ((incoming as Partial<BuiltInServiceCategoryConfig>).apiKey === undefined) {
        next.apiKey = current.serviceCatalog[category].apiKey;
      }
      mergedCatalog[category] = next;
    }
  }

  const merged: BuiltInRuntimeSettings = {
    serviceGatewayUrl: normalizeUrl(input.serviceGatewayUrl || current.serviceGatewayUrl),
    iopaintUrls:
      Array.isArray(input.iopaintUrls)
        ? input.iopaintUrls
            .map((item) => normalizeUrl(item))
            .filter((item) => /^https?:\/\//i.test(item))
        : current.iopaintUrls,
    updatePageUrl:
      typeof input.updatePageUrl === 'string'
        ? (() => {
            const parsed = normalizeUrl(input.updatePageUrl);
            return /^https?:\/\//i.test(parsed) ? parsed : '';
          })()
        : current.updatePageUrl,
    downloadChannels:
      input.downloadChannels !== undefined
        ? parseDownloadChannels(input.downloadChannels)
        : current.downloadChannels,
    serviceCatalog: mergedCatalog,
  };

  await Promise.all([
    setSystemSetting('service_gateway_url', merged.serviceGatewayUrl),
    setSystemSetting('iopaint_urls', JSON.stringify(merged.iopaintUrls)),
    setSystemSetting('update_page_url', merged.updatePageUrl),
    setSystemSetting('download_channels', JSON.stringify(merged.downloadChannels)),
    persistServiceCatalog(merged.serviceCatalog),
  ]);

  return merged;
}

/**
 * Initialize image generation tasks table
 * Creates the table for storing async image generation task records
 */
export async function initializeImageTasksTable(): Promise<void> {
  try {
    console.log('Initializing image_generation_tasks table...');

    // Create image_generation_tasks table
    await sql`
      CREATE TABLE IF NOT EXISTS image_generation_tasks (
        id SERIAL PRIMARY KEY,
        task_id VARCHAR(255) UNIQUE NOT NULL,
        user_id VARCHAR(255) NOT NULL,
        status VARCHAR(50) NOT NULL,
        prompt TEXT NOT NULL,
        request_params JSONB,
        result_image TEXT,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP
      )
    `;

    // Create indexes for optimized query performance
    await sql`
      CREATE INDEX IF NOT EXISTS idx_task_id ON image_generation_tasks(task_id)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_user_id_tasks ON image_generation_tasks(user_id)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_status_tasks ON image_generation_tasks(status)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_created_at_tasks ON image_generation_tasks(created_at)
    `;

    console.log('✅ image_generation_tasks table initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize image_generation_tasks table:', error);
    throw error;
  }
}

/**
 * Initialize usage tracking table
 * Creates the table for storing API usage records
 */
export async function initializeUsageTrackingTable(): Promise<void> {
  try {
    console.log('Initializing api_usage_records table...');

    // Create api_usage_records table
    await sql`
      CREATE TABLE IF NOT EXISTS api_usage_records (
        id SERIAL PRIMARY KEY,
        request_id VARCHAR(255) UNIQUE NOT NULL,
        user_id VARCHAR(255) NOT NULL,
        service_id VARCHAR(255) NOT NULL,
        success BOOLEAN NOT NULL,
        response_time INTEGER,
        error TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    // Create indexes for optimized query performance
    await sql`
      CREATE INDEX IF NOT EXISTS idx_user_id_usage ON api_usage_records(user_id)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_service_id_usage ON api_usage_records(service_id)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_created_at_usage ON api_usage_records(created_at)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_user_date_usage ON api_usage_records(user_id, created_at)
    `;

    console.log('✅ api_usage_records table initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize api_usage_records table:', error);
    throw error;
  }
}

/**
 * Import users from environment variable to database
 */
export async function importUsersFromEnv(): Promise<number> {
  try {
    await ensureAuthorizedUsersTable();
    const envUsersStr = process.env.AUTHORIZED_USERS;
    if (!envUsersStr) {
      console.log('No AUTHORIZED_USERS environment variable found');
      return 0;
    }

    // Parse environment variable
    let jsonString = envUsersStr;
    if (jsonString.includes('\\"')) {
      jsonString = jsonString.replace(/\\"/g, '"');
    }

    const users = JSON.parse(jsonString);
    if (!Array.isArray(users)) {
      console.warn('AUTHORIZED_USERS must be an array');
      return 0;
    }

    let importedCount = 0;

    for (const user of users) {
      try {
        await sql`
          INSERT INTO authorized_users (
            user_id, email, name, status,
            can_use_built_in_services, allowed_services,
            daily_requests, monthly_requests, concurrent_requests,
            granted_at, granted_by
          ) VALUES (
            ${user.userId},
            ${user.email},
            ${user.name || user.email},
            ${user.status || 'active'},
            ${user.permissions.canUseBuiltInServices},
            ${user.permissions.allowedServices},
            ${user.permissions.quotaLimits.dailyRequests},
            ${user.permissions.quotaLimits.monthlyRequests},
            ${user.permissions.quotaLimits.concurrentRequests},
            ${user.permissions.grantedAt},
            ${user.permissions.grantedBy}
          )
          ON CONFLICT (user_id) DO NOTHING
        `;
        importedCount++;
      } catch (error) {
        console.error(`Failed to import user ${user.userId}:`, error);
      }
    }

    console.log(`✅ Imported ${importedCount} users from environment variable`);
    return importedCount;
  } catch (error) {
    console.error('Failed to import users from environment:', error);
    return 0;
  }
}

/**
 * Load all authorized users from database
 */
export async function loadUsersFromDatabase(): Promise<AuthorizedUser[]> {
  try {
    await ensureAuthorizedUsersTable();
    console.log('[DB] Loading users from database...');
    const { rows } = await sql`
      SELECT * FROM authorized_users WHERE status = 'active'
    `;

    console.log('[DB] Query returned', rows.length, 'rows');
    console.log('[DB] Raw rows:', JSON.stringify(rows, null, 2));

    const users = rows.map(row => {
      console.log('[DB] Processing row:', row.user_id);
      console.log('[DB] Row data:', {
        user_id: row.user_id,
        email: row.email,
        name: row.name,
        status: row.status,
        can_use_built_in_services: row.can_use_built_in_services,
        allowed_services: row.allowed_services,
        allowed_services_type: typeof row.allowed_services,
        allowed_services_isArray: Array.isArray(row.allowed_services),
      });

      return {
        userId: row.user_id,
        email: row.email,
        name: row.name,
        status: row.status,
        permissions: {
          canUseBuiltInServices: row.can_use_built_in_services,
          allowedServices: row.allowed_services || [],
          quotaLimits: {
            dailyRequests: row.daily_requests,
            monthlyRequests: row.monthly_requests,
            concurrentRequests: row.concurrent_requests
          },
          grantedAt: new Date(row.granted_at),
          grantedBy: row.granted_by
        }
      };
    });

    console.log('[DB] Mapped users:', JSON.stringify(users, null, 2));
    return users;
  } catch (error) {
    console.error('[DB] Failed to load users from database:', error);
    console.error('[DB] Error details:', error instanceof Error ? error.message : 'Unknown');
    console.error('[DB] Error stack:', error instanceof Error ? error.stack : 'No stack');
    throw error;
  }
}

/**
 * Save a user to database
 */
export async function saveUserToDatabase(user: AuthorizedUser): Promise<void> {
  try {
    await ensureAuthorizedUsersTable();
    // Convert allowedServices array to PostgreSQL array literal
    const allowedServicesArray = user.permissions.allowedServices || [];
    const allowedServicesLiteral = `{${allowedServicesArray.map(s => `"${s}"`).join(',')}}`;
    
    await sql`
      INSERT INTO authorized_users (
        user_id, email, name, status,
        can_use_built_in_services, allowed_services,
        daily_requests, monthly_requests, concurrent_requests,
        granted_at, granted_by
      ) VALUES (
        ${user.userId},
        ${user.email},
        ${user.name},
        ${user.status},
        ${user.permissions.canUseBuiltInServices},
        ${allowedServicesLiteral}::text[],
        ${user.permissions.quotaLimits.dailyRequests},
        ${user.permissions.quotaLimits.monthlyRequests},
        ${user.permissions.quotaLimits.concurrentRequests},
        ${user.permissions.grantedAt.toISOString()},
        ${user.permissions.grantedBy}
      )
      ON CONFLICT (user_id) 
      DO UPDATE SET
        email = EXCLUDED.email,
        name = EXCLUDED.name,
        status = EXCLUDED.status,
        can_use_built_in_services = EXCLUDED.can_use_built_in_services,
        allowed_services = EXCLUDED.allowed_services,
        daily_requests = EXCLUDED.daily_requests,
        monthly_requests = EXCLUDED.monthly_requests,
        concurrent_requests = EXCLUDED.concurrent_requests,
        granted_by = EXCLUDED.granted_by,
        updated_at = CURRENT_TIMESTAMP
    `;
  } catch (error) {
    console.error('Failed to save user to database:', error);
    throw error;
  }
}

/**
 * Delete a user from database
 */
export async function deleteUserFromDatabase(userId: string): Promise<void> {
  try {
    await ensureAuthorizedUsersTable();
    await sql`
      DELETE FROM authorized_users WHERE user_id = ${userId}
    `;
  } catch (error) {
    console.error('Failed to delete user from database:', error);
    throw error;
  }
}

/**
 * Update user status in database
 */
export async function updateUserStatus(userId: string, status: 'active' | 'suspended'): Promise<void> {
  try {
    await ensureAuthorizedUsersTable();
    console.log(`[DB] Updating user status: ${userId} -> ${status}`);
    await sql`
      UPDATE authorized_users 
      SET status = ${status}, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ${userId}
    `;
    console.log(`[DB] User status updated successfully`);
  } catch (error) {
    console.error('Failed to update user status:', error);
    throw error;
  }
}

/**
 * Get database statistics
 */
export async function getDatabaseStats(): Promise<{
  totalUsers: number;
  activeUsers: number;
  suspendedUsers: number;
}> {
  try {
    await ensureAuthorizedUsersTable();
    console.log('[DB Stats] Getting database statistics...');
    
    const { rows: totalRows } = await sql`
      SELECT COUNT(*)::int as count FROM authorized_users
    `;
    console.log('[DB Stats] Total rows:', totalRows);

    const { rows: activeRows } = await sql`
      SELECT COUNT(*)::int as count FROM authorized_users WHERE status = 'active'
    `;
    console.log('[DB Stats] Active rows:', activeRows);

    const { rows: suspendedRows } = await sql`
      SELECT COUNT(*)::int as count FROM authorized_users WHERE status = 'suspended'
    `;
    console.log('[DB Stats] Suspended rows:', suspendedRows);

    const stats = {
      totalUsers: Number(totalRows[0].count) || 0,
      activeUsers: Number(activeRows[0].count) || 0,
      suspendedUsers: Number(suspendedRows[0].count) || 0
    };

    console.log('[DB Stats] Final stats:', stats);
    return stats;
  } catch (error) {
    console.error('[DB Stats] Failed to get database stats:', error);
    console.error('[DB Stats] Error details:', error instanceof Error ? error.message : 'Unknown');
    return {
      totalUsers: 0,
      activeUsers: 0,
      suspendedUsers: 0
    };
  }
}

/**
 * Record API usage to database
 * 🔧 FIX: 规范化用户ID为小写，确保查询时能够匹配
 */
export async function recordUsageToDatabase(
  requestId: string,
  userId: string,
  serviceId: string,
  success: boolean,
  responseTime?: number,
  error?: string
): Promise<void> {
  try {
    // 🔧 FIX: 规范化用户ID为小写
    const normalizedUserId = userId.trim().toLowerCase();

    await sql`
      INSERT INTO api_usage_records (
        request_id, user_id, service_id, success, response_time, error
      ) VALUES (
        ${requestId},
        ${normalizedUserId},
        ${serviceId},
        ${success},
        ${responseTime || null},
        ${error || null}
      )
    `;
  } catch (error) {
    console.error('Failed to record usage to database:', error);
    // Don't throw error to avoid breaking the main request flow
  }
}

/**
 * Get user usage statistics
 * 🔧 FIX: 支持大小写不敏感的用户ID匹配，兼容历史数据
 */
export async function getUserUsageStats(userId: string): Promise<{
  dailyUsage: number;
  monthlyUsage: number;
}> {
  try {
    const normalizedUserId = userId.trim().toLowerCase();

    // Get today's usage - 使用大小写不敏感匹配
    const { rows: dailyRows } = await sql`
      SELECT COUNT(*) as count
      FROM api_usage_records
      WHERE LOWER(user_id) = ${normalizedUserId}
        AND created_at >= CURRENT_DATE
        AND created_at < CURRENT_DATE + INTERVAL '1 day'
    `;

    // Get this month's usage - 使用大小写不敏感匹配
    const { rows: monthlyRows } = await sql`
      SELECT COUNT(*) as count
      FROM api_usage_records
      WHERE LOWER(user_id) = ${normalizedUserId}
        AND created_at >= DATE_TRUNC('month', CURRENT_DATE)
        AND created_at < DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'
    `;

    return {
      dailyUsage: parseInt(dailyRows[0]?.count || '0'),
      monthlyUsage: parseInt(monthlyRows[0]?.count || '0'),
    };
  } catch (error) {
    console.error('Failed to get user usage stats:', error);
    return { dailyUsage: 0, monthlyUsage: 0 };
  }
}

/**
 * Get all users usage statistics (for admin dashboard)
 * 🔧 FIX: 支持双向ID匹配 - 同时匹配 user_id 和 email 字段
 */
export async function getAllUsersUsageStats(): Promise<Array<{
  userId: string;
  dailyUsage: number;
  monthlyUsage: number;
}>> {
  try {
    await ensureAuthorizedUsersTable();
    // Get all users with their usage stats
    // 🔧 FIX: 使用 OR 条件匹配 user_id 或 email，并使用 LOWER 进行大小写不敏感匹配
    const { rows } = await sql`
      SELECT
        u.user_id,
        u.email,
        COUNT(CASE WHEN r.created_at >= CURRENT_DATE THEN 1 END) as daily_usage,
        COUNT(CASE WHEN r.created_at >= DATE_TRUNC('month', CURRENT_DATE) THEN 1 END) as monthly_usage
      FROM authorized_users u
      LEFT JOIN api_usage_records r ON (
        LOWER(u.user_id) = LOWER(r.user_id) OR
        LOWER(u.email) = LOWER(r.user_id)
      )
      WHERE u.status = 'active'
      GROUP BY u.user_id, u.email
    `;

    return rows.map(row => ({
      userId: row.user_id,
      dailyUsage: parseInt(row.daily_usage || '0'),
      monthlyUsage: parseInt(row.monthly_usage || '0'),
    }));
  } catch (error) {
    console.error('Failed to get all users usage stats:', error);
    return [];
  }
}

/**
 * Initialize terms acceptance table
 * Creates the table for storing user terms of service acceptance records
 */
export async function initializeTermsAcceptanceTable(): Promise<void> {
  try {
    console.log('Initializing terms_acceptance table...');

    // Create terms_acceptance table
    await sql`
      CREATE TABLE IF NOT EXISTS terms_acceptance (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        terms_version VARCHAR(20) DEFAULT '1.0',
        accepted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ip_address VARCHAR(45),
        user_agent TEXT,
        device_info JSONB,
        UNIQUE(user_id, terms_version)
      )
    `;

    // Create indexes for optimized query performance
    await sql`
      CREATE INDEX IF NOT EXISTS idx_user_id_terms ON terms_acceptance(user_id)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_accepted_at ON terms_acceptance(accepted_at)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_terms_version ON terms_acceptance(terms_version)
    `;

    console.log('✅ terms_acceptance table initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize terms_acceptance table:', error);
    throw error;
  }
}

/**
 * Record terms acceptance to database
 */
export async function recordTermsAcceptance(
  userId: string,
  email: string | null,
  ipAddress: string | null,
  userAgent: string | null,
  termsVersion: string = '1.0'
): Promise<void> {
  try {
    console.log(`[DB] Recording terms acceptance for user: ${userId}`);
    
    // Parse user agent to extract device info
    const deviceInfo = userAgent ? parseUserAgent(userAgent) : null;

    await sql`
      INSERT INTO terms_acceptance (
        user_id, email, terms_version, ip_address, user_agent, device_info
      ) VALUES (
        ${userId},
        ${email},
        ${termsVersion},
        ${ipAddress},
        ${userAgent},
        ${deviceInfo ? JSON.stringify(deviceInfo) : null}
      )
      ON CONFLICT (user_id, terms_version) 
      DO UPDATE SET
        accepted_at = CURRENT_TIMESTAMP,
        ip_address = EXCLUDED.ip_address,
        user_agent = EXCLUDED.user_agent,
        device_info = EXCLUDED.device_info
    `;

    console.log(`✅ Terms acceptance recorded for user: ${userId}`);
  } catch (error) {
    console.error('Failed to record terms acceptance:', error);
    throw error;
  }
}

/**
 * Check if user has accepted terms
 */
export async function hasAcceptedTerms(
  userId: string,
  termsVersion: string = '1.0'
): Promise<boolean> {
  try {
    const { rows } = await sql`
      SELECT id FROM terms_acceptance
      WHERE user_id = ${userId}
        AND terms_version = ${termsVersion}
    `;

    return rows.length > 0;
  } catch (error) {
    console.error('Failed to check terms acceptance:', error);
    return false;
  }
}

/**
 * Get user terms acceptance record
 */
export async function getUserTermsAcceptance(userId: string): Promise<{
  userId: string;
  email: string | null;
  termsVersion: string;
  acceptedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  deviceInfo: any;
} | null> {
  try {
    const { rows } = await sql`
      SELECT 
        user_id, email, terms_version, accepted_at, 
        ip_address, user_agent, device_info
      FROM terms_acceptance
      WHERE user_id = ${userId}
      ORDER BY accepted_at DESC
      LIMIT 1
    `;

    if (rows.length === 0) {
      return null;
    }

    const row = rows[0];
    return {
      userId: row.user_id,
      email: row.email,
      termsVersion: row.terms_version,
      acceptedAt: new Date(row.accepted_at),
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      deviceInfo: row.device_info
    };
  } catch (error) {
    console.error('Failed to get user terms acceptance:', error);
    return null;
  }
}

/**
 * Get all terms acceptance records (for admin)
 */
export async function getAllTermsAcceptanceRecords(): Promise<Array<{
  userId: string;
  email: string | null;
  termsVersion: string;
  acceptedAt: Date;
  ipAddress: string | null;
}>> {
  try {
    const { rows } = await sql`
      SELECT 
        user_id, email, terms_version, accepted_at, ip_address
      FROM terms_acceptance
      ORDER BY accepted_at DESC
      LIMIT 1000
    `;

    return rows.map(row => ({
      userId: row.user_id,
      email: row.email,
      termsVersion: row.terms_version,
      acceptedAt: new Date(row.accepted_at),
      ipAddress: row.ip_address
    }));
  } catch (error) {
    console.error('Failed to get all terms acceptance records:', error);
    return [];
  }
}

/**
 * Get terms acceptance statistics
 */
export async function getTermsAcceptanceStats(): Promise<{
  totalAcceptances: number;
  uniqueUsers: number;
  todayAcceptances: number;
  thisWeekAcceptances: number;
  currentVersion: string;
}> {
  try {
    const { rows: totalRows } = await sql`
      SELECT COUNT(*)::int as count FROM terms_acceptance
    `;

    const { rows: uniqueRows } = await sql`
      SELECT COUNT(DISTINCT user_id)::int as count FROM terms_acceptance
    `;

    const { rows: todayRows } = await sql`
      SELECT COUNT(*)::int as count 
      FROM terms_acceptance
      WHERE accepted_at >= CURRENT_DATE
    `;

    const { rows: weekRows } = await sql`
      SELECT COUNT(*)::int as count 
      FROM terms_acceptance
      WHERE accepted_at >= CURRENT_DATE - INTERVAL '7 days'
    `;

    return {
      totalAcceptances: Number(totalRows[0].count) || 0,
      uniqueUsers: Number(uniqueRows[0].count) || 0,
      todayAcceptances: Number(todayRows[0].count) || 0,
      thisWeekAcceptances: Number(weekRows[0].count) || 0,
      currentVersion: '1.0'
    };
  } catch (error) {
    console.error('Failed to get terms acceptance stats:', error);
    return {
      totalAcceptances: 0,
      uniqueUsers: 0,
      todayAcceptances: 0,
      thisWeekAcceptances: 0,
      currentVersion: '1.0'
    };
  }
}

/**
 * Parse user agent string to extract device info
 */
function parseUserAgent(userAgent: string): {
  browser: string;
  os: string;
  device: string;
} {
  const info = {
    browser: 'Unknown',
    os: 'Unknown',
    device: 'Unknown'
  };

  // Detect browser
  if (userAgent.includes('Chrome')) info.browser = 'Chrome';
  else if (userAgent.includes('Firefox')) info.browser = 'Firefox';
  else if (userAgent.includes('Safari')) info.browser = 'Safari';
  else if (userAgent.includes('Edge')) info.browser = 'Edge';
  else if (userAgent.includes('Opera')) info.browser = 'Opera';

  // Detect OS
  if (userAgent.includes('Windows')) info.os = 'Windows';
  else if (userAgent.includes('Mac OS')) info.os = 'macOS';
  else if (userAgent.includes('Linux')) info.os = 'Linux';
  else if (userAgent.includes('Android')) info.os = 'Android';
  else if (userAgent.includes('iOS') || userAgent.includes('iPhone') || userAgent.includes('iPad')) info.os = 'iOS';

  // Detect device
  if (userAgent.includes('Mobile')) info.device = 'Mobile';
  else if (userAgent.includes('Tablet') || userAgent.includes('iPad')) info.device = 'Tablet';
  else info.device = 'Desktop';

  return info;
}
