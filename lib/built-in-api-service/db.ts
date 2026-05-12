/**
 * Database utilities for Vercel Postgres
 * Handles database connection and table initialization
 */

import { sql } from '@vercel/postgres';
import { AuthorizedUser } from './types';
import { encryptSecret, decryptSecret, maskSecret } from './encryption';

export type BuiltInUsageServiceStat = {
  service: string;
  label: string;
  dailyUsage: number;
  monthlyUsage: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageResponseTime: number;
  lastUsed: string | null;
};

const TRACKED_USAGE_SERVICES = [
  { service: 'image', label: '图像生成' },
  { service: 'tts', label: '云端 TTS' },
  { service: 'video', label: '视频生成' },
] as const;

export const normalizeBuiltInUsageService = (serviceId: unknown) => {
  const raw = String(serviceId || '').trim().toLowerCase();
  if (raw.startsWith('tts')) return { service: 'tts', label: '云端 TTS' };
  if (raw.startsWith('video')) return { service: 'video', label: '视频生成' };
  if (raw.startsWith('image')) return { service: 'image', label: '图像生成' };
  if (
    raw === 'built-in-default' ||
    raw === 'gemini-built-in' ||
    raw.includes('image') ||
    raw.includes('gemini')
  ) {
    return { service: 'image', label: '图像生成' };
  }
  return { service: raw || 'other', label: raw || '其它服务' };
};

type ServiceUsageAccumulator = BuiltInUsageServiceStat & {
  responseTimeTotal: number;
  responseTimeWeight: number;
};

const createServiceUsageMap = () => {
  const map = new Map<string, ServiceUsageAccumulator>();
  for (const service of TRACKED_USAGE_SERVICES) {
    map.set(service.service, {
      service: service.service,
      label: service.label,
      dailyUsage: 0,
      monthlyUsage: 0,
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageResponseTime: 0,
      lastUsed: null,
      responseTimeTotal: 0,
      responseTimeWeight: 0,
    });
  }
  return map;
};

const normalizeDbDate = (value: unknown): string | null => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
};

const addServiceUsageRow = (
  map: Map<string, ServiceUsageAccumulator>,
  row: {
    service_id?: unknown;
    daily_usage?: unknown;
    monthly_usage?: unknown;
    total_requests?: unknown;
    successful_requests?: unknown;
    failed_requests?: unknown;
    average_response_time?: unknown;
    last_used?: unknown;
  }
) => {
  if (!row.service_id) return;
  const normalized = normalizeBuiltInUsageService(row.service_id);
  const current =
    map.get(normalized.service) || {
      service: normalized.service,
      label: normalized.label,
      dailyUsage: 0,
      monthlyUsage: 0,
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageResponseTime: 0,
      lastUsed: null,
      responseTimeTotal: 0,
      responseTimeWeight: 0,
    };

  const totalRequests = Number(row.total_requests) || 0;
  const averageResponseTime = Number(row.average_response_time) || 0;
  current.dailyUsage += Number(row.daily_usage) || 0;
  current.monthlyUsage += Number(row.monthly_usage) || 0;
  current.totalRequests += totalRequests;
  current.successfulRequests += Number(row.successful_requests) || 0;
  current.failedRequests += Number(row.failed_requests) || 0;
  if (averageResponseTime > 0 && totalRequests > 0) {
    current.responseTimeTotal += averageResponseTime * totalRequests;
    current.responseTimeWeight += totalRequests;
  }

  const lastUsed = normalizeDbDate(row.last_used);
  if (lastUsed && (!current.lastUsed || new Date(lastUsed) > new Date(current.lastUsed))) {
    current.lastUsed = lastUsed;
  }
  map.set(normalized.service, current);
};

const finalizeServiceUsageMap = (
  map: Map<string, ServiceUsageAccumulator>
): BuiltInUsageServiceStat[] => {
  const serviceOrder = new Map<string, number>(
    TRACKED_USAGE_SERVICES.map((item, index) => [item.service, index])
  );
  return Array.from(map.values())
    .map((item) => ({
      service: item.service,
      label: item.label,
      dailyUsage: item.dailyUsage,
      monthlyUsage: item.monthlyUsage,
      totalRequests: item.totalRequests,
      successfulRequests: item.successfulRequests,
      failedRequests: item.failedRequests,
      averageResponseTime:
        item.responseTimeWeight > 0
          ? Math.round(item.responseTimeTotal / item.responseTimeWeight)
          : 0,
      lastUsed: item.lastUsed,
    }))
    .sort((a, b) => {
      const left = serviceOrder.get(a.service) ?? 99;
      const right = serviceOrder.get(b.service) ?? 99;
      return left === right ? b.totalRequests - a.totalRequests : left - right;
    });
};

/**
 * 6 大类内置服务，与桌面端 API 设置面板严格 1:1 对齐：
 *   - 多模态 AI (multimodal) → desktop 多模态 AI tab
 *   - 文本 AI (text)         → desktop 文本 AI tab
 *   - 图像生成 (image)        → desktop 图像 AI tab 上半 ("图像生成 AI")
 *   - 图像理解 (vision)       → desktop 图像 AI tab 下半 ("图像理解 AI")
 *   - 配音 TTS (tts)          → desktop 配音 TTS tab
 *   - 视频 AI (video)         → desktop 视频 AI tab
 *
 * 🔧 BREAKING (2026-05 #22): 新增 'vision'；同时把所有类的 subtask 预设
 *   从「3 子类（音频理解 / 通用多模态 / 视觉理解 等）」收敛成「1 个 default」，
 *   admin UI 只暴露每类一个表单，与桌面端一致。
 */
export const BUILT_IN_SERVICE_CATEGORIES = [
  'multimodal',
  'text',
  'image',
  'vision',
  'tts',
  'video',
] as const;

export type BuiltInServiceCategory = (typeof BUILT_IN_SERVICE_CATEGORIES)[number];

/**
 * 单一子任务配置（同一类下可有多个子任务，例如图像生成 vs 图像理解）
 *
 * 🔧 NEW (2026-05 #21): models 字段 — 该子任务可用的全部模型列表（默认排序：
 *   model 永远在 models[0]）。桌面端「API 设置 → 分类模型」下拉用 models 全量
 *   显示，model 作为 ⭐ 默认选中。旧 catalog（无 models 字段）会被自动补成
 *   models = [model]，保证不会出现"只有一个默认模型"的窘境。
 */
export interface BuiltInServiceSubtaskConfig {
  id: string;
  displayName: string;
  description?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  models?: string[]; // 🔧 NEW (2026-05 #21)
  // 🔧 NEW (2026-05 #24): video category 专用 — 上游视频接口路径（如 /v1/videos）。
  //   留空时 video route 走兜底（baseUrl + /video/generations）。
  //   其它 category 不读这个字段。
  endpointPath?: string;
  isEnabled: boolean;
  updatedAt?: string;
}

/**
 * 类别配置：包含若干子任务 + 默认子任务 ID
 */
export interface BuiltInServiceCategoryConfig {
  displayName: string;
  description?: string;
  defaultSubtaskId: string;
  subtasks: Record<string, BuiltInServiceSubtaskConfig>;
}

export type BuiltInServiceCatalog = Record<BuiltInServiceCategory, BuiltInServiceCategoryConfig>;

const SERVICE_CATALOG_SETTING_KEY_PREFIX = 'service_catalog_';

/**
 * 6 大类的中文展示信息
 */
const CATEGORY_META: Record<BuiltInServiceCategory, { displayName: string; description: string }> = {
  multimodal: { displayName: '多模态 AI', description: '同时处理图像/音频/文本的综合理解模型' },
  text: { displayName: '文本 AI', description: '纯文本生成、改写、摘要、规划' },
  image: { displayName: '图像生成 AI', description: '文生图 / 图生图 / 图像编辑' },
  vision: { displayName: '图像理解 AI', description: '识别图像内容 / 视觉问答' },
  tts: { displayName: '配音 TTS', description: '文本转语音' },
  video: { displayName: '视频 AI', description: '文生视频 / 图生视频' },
};

/**
 * 子任务预设：为对齐桌面端 1:1 UI，每类只保留 1 个 default 预设。
 * 旧 catalog 里的 subcategory（如 image:generation/understanding/edit）会在
 * loadServiceCatalog 时被收敛到 default 子任务。
 */
type SubtaskPreset = { id: string; displayName: string; description?: string; defaultModel: string };

const SUBTASK_PRESETS: Record<BuiltInServiceCategory, SubtaskPreset[]> = {
  multimodal: [
    { id: 'default', displayName: '多模态 AI', description: '与桌面端「多模态 AI」tab 对齐', defaultModel: 'gpt-4o' },
  ],
  text: [
    { id: 'default', displayName: '文本 AI', description: '与桌面端「文本 AI」tab 对齐', defaultModel: 'gpt-4o-mini' },
  ],
  image: [
    { id: 'default', displayName: '图像生成 AI', description: '与桌面端「图像 AI」tab 上半部分对齐', defaultModel: 'gpt-image-1' },
  ],
  vision: [
    { id: 'default', displayName: '图像理解 AI', description: '与桌面端「图像 AI」tab 下半部分对齐', defaultModel: 'gpt-4o' },
  ],
  tts: [
    { id: 'default', displayName: '配音 TTS', description: '与桌面端「配音 TTS」tab 对齐', defaultModel: 'tts-1' },
  ],
  video: [
    { id: 'default', displayName: '视频 AI', description: '与桌面端「视频 AI」tab 对齐', defaultModel: 'sora-1' },
  ],
};

const PRESET_SUBTASK_IDS: Record<BuiltInServiceCategory, Set<string>> = BUILT_IN_SERVICE_CATEGORIES.reduce(
  (acc, key) => {
    acc[key] = new Set(SUBTASK_PRESETS[key].map((s) => s.id));
    return acc;
  },
  {} as Record<BuiltInServiceCategory, Set<string>>
);

function makeDefaultSubtask(category: BuiltInServiceCategory, preset: SubtaskPreset): BuiltInServiceSubtaskConfig {
  return {
    id: preset.id,
    displayName: preset.displayName,
    description: preset.description,
    baseUrl: '',
    apiKey: '',
    model: preset.defaultModel,
    isEnabled: false,
  };
}

function makeEmptyCategory(category: BuiltInServiceCategory): BuiltInServiceCategoryConfig {
  const presets = SUBTASK_PRESETS[category];
  const subtasks: Record<string, BuiltInServiceSubtaskConfig> = {};
  for (const preset of presets) {
    subtasks[preset.id] = makeDefaultSubtask(category, preset);
  }
  return {
    displayName: CATEGORY_META[category].displayName,
    description: CATEGORY_META[category].description,
    defaultSubtaskId: presets[0].id,
    subtasks,
  };
}

function makeEmptyCatalog(): BuiltInServiceCatalog {
  return BUILT_IN_SERVICE_CATEGORIES.reduce((acc, key) => {
    acc[key] = makeEmptyCategory(key);
    return acc;
  }, {} as BuiltInServiceCatalog);
}

function sanitizeSubtaskId(raw: unknown, fallback = 'default'): string {
  const trimmed = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return trimmed || fallback;
}

function normalizeEndpointPath(raw: unknown, fallback?: string): string | undefined {
  if (raw === undefined || raw === null) return fallback || undefined;
  if (typeof raw !== 'string') return fallback || undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function normalizeSubtaskInput(
  category: BuiltInServiceCategory,
  subtaskId: string,
  raw: unknown,
  base?: BuiltInServiceSubtaskConfig
): BuiltInServiceSubtaskConfig {
  const preset = SUBTASK_PRESETS[category].find((p) => p.id === subtaskId);
  const fallbackModel = preset?.defaultModel || base?.model || '';
  const fallbackName = preset?.displayName || base?.displayName || subtaskId;
  const fallbackDesc = preset?.description ?? base?.description;
  if (!raw || typeof raw !== 'object') {
    const fallbackModels = Array.isArray(base?.models) ? [...(base?.models || [])] : [];
    return {
      id: subtaskId,
      displayName: fallbackName,
      description: fallbackDesc,
      baseUrl: base?.baseUrl || '',
      apiKey: base?.apiKey || '',
      model: base?.model || fallbackModel,
      models: ensureModelInList(base?.model || fallbackModel, fallbackModels),
      endpointPath: base?.endpointPath,
      isEnabled: base?.isEnabled || false,
    };
  }
  const record = raw as Record<string, unknown>;
  const baseUrl = String(record.baseUrl ?? base?.baseUrl ?? '').trim().replace(/\/+$/, '');
  const apiKey =
    typeof record.apiKey === 'string'
      ? record.apiKey
      : base?.apiKey || '';
  const model = String(record.model ?? base?.model ?? fallbackModel ?? '').trim() || fallbackModel;
  const isEnabled = record.isEnabled === undefined ? Boolean(base?.isEnabled) : Boolean(record.isEnabled);
  const displayName = String(record.displayName ?? base?.displayName ?? fallbackName ?? subtaskId).trim() || fallbackName;
  const description =
    typeof record.description === 'string'
      ? record.description
      : base?.description ?? fallbackDesc;
  // 🔧 NEW (2026-05 #21): models 字段。优先用 patch 里的 models（admin 显式传入），
  // 否则保留 base 里既有的，最后兜底 [model] 防止空列表。
  const incomingModels = sanitizeModelList(record.models);
  const baseModels = Array.isArray(base?.models) ? [...(base?.models || [])] : [];
  const modelsRaw = incomingModels !== null ? incomingModels : baseModels;
  const models = ensureModelInList(model, modelsRaw);
  // endpointPath is a PATCH tri-state: missing keeps the old value, an empty
  // string clears it, and a non-empty value may be either a path or full URL.
  const endpointPath = Object.prototype.hasOwnProperty.call(record, 'endpointPath')
    ? normalizeEndpointPath(record.endpointPath)
    : base?.endpointPath || undefined;
  return { id: subtaskId, displayName, description, baseUrl, apiKey, model, models, endpointPath, isEnabled };
}

/**
 * 🔧 NEW (2026-05 #21): 校验/清洗 models 数组。
 *   - 非数组 → null（表示"未传"，由 base/fallback 接管）
 *   - 数组里每条 trim、去空、去重；保持顺序
 */
function sanitizeModelList(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const t = typeof item === 'string' ? item.trim() : '';
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * 🔧 NEW (2026-05 #21): 确保 default model 永远在 models[0]。
 *   admin 即使忘记把默认 model 加进 models 列表，前端拉到的列表也会先看见它。
 */
function ensureModelInList(model: string, models: string[]): string[] {
  const m = (model || '').trim();
  const cleaned: string[] = [];
  const seen = new Set<string>();
  if (m) {
    cleaned.push(m);
    seen.add(m);
  }
  for (const item of models || []) {
    const t = (item || '').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    cleaned.push(t);
  }
  return cleaned;
}

export function getSubtaskPresets(): Record<BuiltInServiceCategory, SubtaskPreset[]> {
  return SUBTASK_PRESETS;
}

export function getCategoryMeta(): Record<BuiltInServiceCategory, { displayName: string; description: string }> {
  return CATEGORY_META;
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

    // 🔧 NEW: Initialize per-user built-in config table (Render cold-start safe)
    await initializeUserConfigsTable();

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

/**
 * 🔧 NEW: 用户的 built-in 切换偏好持久化（解决 Render free tier 冷启动后丢失的问题）
 *
 * 历史背景：
 *   ConfigurationStorageImpl.saveUserConfig 检测到 serverless 环境后直接 skip，
 *   userConfig 仅保存在进程内存里。Render free tier 在 ~15 分钟无请求后冷重启，
 *   重启后用户的「我已切换到内置」状态丢失，下次桌面端查询 `?action=status`
 *   会拿到 `isUsingBuiltIn=false`，UI 看起来「重置回原状」。
 *
 * 这个表用 user_id 主键存 UserServiceConfig 的 JSON，正好绕过 ephemeral filesystem。
 */
export async function initializeUserConfigsTable(): Promise<void> {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS built_in_user_configs (
        user_id VARCHAR(255) PRIMARY KEY,
        config_json TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
  } catch (error) {
    console.error('Failed to initialize built_in_user_configs table:', error);
    throw error;
  }
}

export async function loadUserConfigFromDatabase(userId: string): Promise<string | null> {
  try {
    const { rows } = await sql`
      SELECT config_json FROM built_in_user_configs
      WHERE user_id = ${userId}
      LIMIT 1
    `;
    return rows[0]?.config_json ?? null;
  } catch (error) {
    console.error(`Failed to load user config for ${userId}:`, error);
    return null;
  }
}

export async function saveUserConfigToDatabase(userId: string, configJson: string): Promise<void> {
  await sql`
    INSERT INTO built_in_user_configs (user_id, config_json, updated_at)
    VALUES (${userId}, ${configJson}, CURRENT_TIMESTAMP)
    ON CONFLICT (user_id)
    DO UPDATE SET
      config_json = EXCLUDED.config_json,
      updated_at = CURRENT_TIMESTAMP
  `;
}

export async function deleteUserConfigFromDatabase(userId: string): Promise<void> {
  try {
    await sql`DELETE FROM built_in_user_configs WHERE user_id = ${userId}`;
  } catch (error) {
    console.error(`Failed to delete user config for ${userId}:`, error);
  }
}

export type BuiltInRuntimeSettings = {
  serviceGatewayUrl: string;
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
  // 🔧 NEW (2026-05 #22): 在迁移时把 image 旧 subtask 的 understanding 抓出来，
  //   迁移完成后若 vision:default 为空，就用它兜底（保留老数据）
  let imageUnderstandingLegacy: BuiltInServiceSubtaskConfig | null = null;
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

        // 检测格式：新格式有 subtasks 字段；旧格式直接有 baseUrl/apiKey/model
        const hasSubtasks = parsed && typeof parsed === 'object' && parsed.subtasks && typeof parsed.subtasks === 'object';

        if (hasSubtasks) {
          // 新格式：完整读取
          const subtasksRaw = parsed.subtasks as Record<string, unknown>;

          // 🔧 BREAKING (2026-05 #22): 现在每类只保留 1 个 default。
          //   旧 catalog（image:generation/understanding/edit、multimodal:vision/audio、
          //   text:plan/summary、video:text2video/image2video 等）会被收敛：
          //   挑「最丰满」的那个 subtask（先看是否有 baseUrl+apiKey+model，再看 models[] 长度）
          //   把它的数据塞进 default。其余子任务从 catalog 里彻底丢弃。
          //   特殊：image:understanding 会被额外缓存，作为 vision:default 的兜底来源。
          const allSubtasks: BuiltInServiceSubtaskConfig[] = [];
          for (const [subtaskId, subtaskRaw] of Object.entries(subtasksRaw)) {
            const safeId = sanitizeSubtaskId(subtaskId);
            if (!safeId) continue;
            const record = subtaskRaw as Record<string, unknown>;
            const decryptedApiKey = typeof record?.apiKey === 'string' ? decryptSecret(record.apiKey) : '';
            const tmp = normalizeSubtaskInput(
              category,
              safeId,
              { ...record, apiKey: decryptedApiKey }
            );
            if (typeof record?.updatedAt === 'string') {
              tmp.updatedAt = record.updatedAt;
            }
            allSubtasks.push(tmp);
          }

          // 缓存 image:understanding 给后续 vision migration
          if (category === 'image') {
            const u = allSubtasks.find((s) => s.id === 'understanding');
            if (u && (u.baseUrl || u.apiKey || u.model)) {
              imageUnderstandingLegacy = u;
            }
          }

          // 排序：default 优先；其次按 (有 url & key) → models 长度 → updatedAt
          const richness = (s: BuiltInServiceSubtaskConfig) => {
            const hasCred = s.baseUrl && s.apiKey ? 1000 : 0;
            const hasModel = s.model ? 100 : 0;
            const modelsLen = Array.isArray(s.models) ? s.models.length : 0;
            return hasCred + hasModel + modelsLen;
          };
          const sorted = [...allSubtasks].sort((a, b) => {
            if (a.id === 'default' && b.id !== 'default') return -1;
            if (b.id === 'default' && a.id !== 'default') return 1;
            return richness(b) - richness(a);
          });

          // 选最丰满的（或 default 自身）作为 default 的源
          const winner = sorted[0];
          const merged: Record<string, BuiltInServiceSubtaskConfig> = {};
          if (winner) {
            const collapsed: BuiltInServiceSubtaskConfig = {
              id: 'default',
              displayName: SUBTASK_PRESETS[category][0].displayName,
              description: SUBTASK_PRESETS[category][0].description,
              baseUrl: winner.baseUrl,
              apiKey: winner.apiKey,
              model: winner.model,
              models: ensureModelInList(winner.model, winner.models || []),
              endpointPath: winner.endpointPath,
              isEnabled: winner.isEnabled,
              updatedAt: winner.updatedAt,
            };
            merged.default = collapsed;
          } else {
            merged.default = makeDefaultSubtask(category, SUBTASK_PRESETS[category][0]);
          }

          catalog[category] = {
            displayName: CATEGORY_META[category].displayName,
            description: CATEGORY_META[category].description,
            defaultSubtaskId: 'default',
            subtasks: merged,
          };
        } else {
          // 旧格式：迁移到新结构 default 子任务
          const legacyApiKey = typeof parsed.apiKey === 'string' ? decryptSecret(parsed.apiKey) : '';
          const legacy = normalizeSubtaskInput(
            category,
            'default',
            { ...parsed, apiKey: legacyApiKey }
          );
          legacy.updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined;
          const empty = makeEmptyCategory(category);
          empty.subtasks.default = legacy;
          catalog[category] = empty;
        }
      } catch (error) {
        console.warn(`[serviceCatalog] 解析 ${category} 配置失败:`, error);
      }
    });

    // 🔧 NEW (2026-05 #22): vision 兜底迁移：
    //   如果 vision:default 还是空（admin 从未配过 vision），
    //   而 image:understanding 在旧数据里有内容，就把它搬过来。
    if (imageUnderstandingLegacy && catalog.vision) {
      const vd = catalog.vision.subtasks.default;
      const visionEmpty = !vd || (!vd.baseUrl && !vd.apiKey && !vd.model);
      if (visionEmpty) {
        catalog.vision.subtasks.default = {
          id: 'default',
          displayName: SUBTASK_PRESETS.vision[0].displayName,
          description: SUBTASK_PRESETS.vision[0].description,
          baseUrl: imageUnderstandingLegacy.baseUrl,
          apiKey: imageUnderstandingLegacy.apiKey,
          model: imageUnderstandingLegacy.model,
          models: ensureModelInList(
            imageUnderstandingLegacy.model,
            imageUnderstandingLegacy.models || []
          ),
          isEnabled: imageUnderstandingLegacy.isEnabled,
          updatedAt: imageUnderstandingLegacy.updatedAt,
        };
        console.log('[serviceCatalog v22] migrated image:understanding → vision:default');
      }
    }
  } catch (error) {
    console.error('[serviceCatalog] 加载失败:', error);
  }
  return catalog;
}

async function persistServiceCatalog(catalog: BuiltInServiceCatalog): Promise<void> {
  await Promise.all(
    BUILT_IN_SERVICE_CATEGORIES.map((category) => {
      const cfg = catalog[category];
      const subtaskPayload: Record<string, unknown> = {};
      for (const [subtaskId, subtask] of Object.entries(cfg.subtasks)) {
        subtaskPayload[subtaskId] = {
          id: subtask.id,
          displayName: subtask.displayName,
          description: subtask.description,
          baseUrl: subtask.baseUrl,
          apiKey: subtask.apiKey ? encryptSecret(subtask.apiKey) : '',
          model: subtask.model,
          // 🔧 NEW (2026-05 #21): 持久化 models 数组
          models: ensureModelInList(subtask.model, subtask.models || []),
          endpointPath: subtask.endpointPath,
          isEnabled: subtask.isEnabled,
          updatedAt: subtask.updatedAt || new Date().toISOString(),
        };
      }
      const payload = {
        displayName: cfg.displayName,
        description: cfg.description,
        defaultSubtaskId: cfg.defaultSubtaskId,
        subtasks: subtaskPayload,
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

/**
 * 更新某个类别下指定子任务的配置（PATCH 语义）
 */
export async function setServiceSubtaskConfig(
  category: BuiltInServiceCategory,
  subtaskId: string,
  patch: Partial<Omit<BuiltInServiceSubtaskConfig, 'id'>>
): Promise<BuiltInServiceSubtaskConfig> {
  await initializeSystemSettingsTable();
  const safeSubtaskId = sanitizeSubtaskId(subtaskId);
  if (!safeSubtaskId) {
    throw new Error(`非法的 subtaskId: ${subtaskId}`);
  }
  const current = await loadServiceCatalog();
  const categoryCfg = current[category];
  const existing = categoryCfg.subtasks[safeSubtaskId];

  // patch.apiKey 未传时保留原值；显式传 null/'' 则清空
  let resolvedPatch: Record<string, unknown> = { ...patch };
  if (patch.apiKey === undefined && existing) {
    resolvedPatch.apiKey = existing.apiKey;
  }

  const next = normalizeSubtaskInput(category, safeSubtaskId, resolvedPatch, existing);
  next.updatedAt = new Date().toISOString();
  categoryCfg.subtasks[safeSubtaskId] = next;
  current[category] = categoryCfg;
  await persistServiceCatalog(current);
  return next;
}

/**
 * 删除非预设的自定义 subtask（预设 ID 拒绝删除）
 */
export async function deleteServiceSubtask(
  category: BuiltInServiceCategory,
  subtaskId: string
): Promise<void> {
  const safeId = sanitizeSubtaskId(subtaskId);
  if (PRESET_SUBTASK_IDS[category].has(safeId)) {
    throw new Error(`预设子任务 ${safeId} 不能删除`);
  }
  await initializeSystemSettingsTable();
  const current = await loadServiceCatalog();
  if (!current[category].subtasks[safeId]) return;
  delete current[category].subtasks[safeId];
  if (current[category].defaultSubtaskId === safeId) {
    current[category].defaultSubtaskId = SUBTASK_PRESETS[category][0].id;
  }
  await persistServiceCatalog(current);
}

/**
 * 设置某类别的默认子任务 ID
 */
export async function setCategoryDefaultSubtask(
  category: BuiltInServiceCategory,
  subtaskId: string
): Promise<void> {
  const safeId = sanitizeSubtaskId(subtaskId);
  await initializeSystemSettingsTable();
  const current = await loadServiceCatalog();
  if (!current[category].subtasks[safeId]) {
    throw new Error(`子任务 ${safeId} 不存在`);
  }
  current[category].defaultSubtaskId = safeId;
  await persistServiceCatalog(current);
}

export function sanitizeServiceCatalog(
  catalog: BuiltInServiceCatalog,
  options: { includeKeyMask?: boolean } = {}
): BuiltInServiceCatalog {
  const out = makeEmptyCatalog();
  for (const category of BUILT_IN_SERVICE_CATEGORIES) {
    const cfg = catalog[category];
    const sanitizedSubtasks: Record<string, BuiltInServiceSubtaskConfig> = {};
    for (const [subtaskId, subtask] of Object.entries(cfg.subtasks)) {
      sanitizedSubtasks[subtaskId] = {
        id: subtask.id,
        displayName: subtask.displayName,
        description: subtask.description,
        baseUrl: subtask.baseUrl,
        apiKey: options.includeKeyMask && subtask.apiKey ? maskSecret(subtask.apiKey) : '',
        model: subtask.model,
        // 🔧 NEW (2026-05 #21): models 数组直通到客户端（不含敏感数据）
        models: ensureModelInList(subtask.model, subtask.models || []),
        // 🔧 NEW (2026-05 #24): endpointPath 直通（video 专用，非敏感数据）
        endpointPath: subtask.endpointPath,
        isEnabled: subtask.isEnabled,
        updatedAt: subtask.updatedAt,
      };
    }
    out[category] = {
      displayName: cfg.displayName,
      description: cfg.description,
      defaultSubtaskId: cfg.defaultSubtaskId,
      subtasks: sanitizedSubtasks,
    };
  }
  return out;
}

/**
 * 获取 category + subtask 的完整服务端配置（含明文 apiKey）。
 * 仅用于代理路由内部转发使用，禁止返回给客户端。
 */
export async function getInternalServiceConfig(
  category: BuiltInServiceCategory,
  subtaskId?: string
): Promise<{ subtask: BuiltInServiceSubtaskConfig; categoryDefaultSubtaskId: string } | null> {
  const catalog = await loadServiceCatalog();
  const cfg = catalog[category];
  if (!cfg) return null;
  const safeId = sanitizeSubtaskId(subtaskId, cfg.defaultSubtaskId);
  const subtask = cfg.subtasks[safeId] || cfg.subtasks[cfg.defaultSubtaskId];
  if (!subtask) return null;
  return { subtask, categoryDefaultSubtaskId: cfg.defaultSubtaskId };
}

export async function getBuiltInRuntimeSettings(): Promise<BuiltInRuntimeSettings> {
  // 🔧 FIX (2026-05 #19): envGateway 用于填充 serviceGatewayUrl，是「上游 AI
  //   网关」(api.seeyjys.eu.org) 的 URL，不是 admin-panel 自身 URL。旧默认
  //   'https://ppt2admin.onrender.com' 是 admin-panel URL，把两个概念搞混了。
  //   改为空字符串：必须显式通过 env 或 DB 配置，避免误用。
  const envGateway = normalizeUrl(
    process.env.BUILT_IN_SERVICE_SERVER_URL ||
      process.env.NEXT_PUBLIC_BUILT_IN_SERVICE_SERVER_URL ||
      ''
  );
  const envUpdatePageUrl = normalizeUrl(
    process.env.BUILT_IN_RELEASE_PAGE_URL ||
      process.env.NEXT_PUBLIC_BUILT_IN_RELEASE_PAGE_URL ||
      ''
  );
  const envDownloadChannelsRaw =
    process.env.BUILT_IN_DOWNLOAD_CHANNELS ||
    process.env.NEXT_PUBLIC_BUILT_IN_DOWNLOAD_CHANNELS ||
    '';
  const envDownloadChannels = parseDownloadChannels(envDownloadChannelsRaw);

  try {
    await initializeSystemSettingsTable();
    const [gatewayValue, updatePageValue, downloadChannelsValue, serviceCatalog] = await Promise.all([
      getSystemSetting('service_gateway_url'),
      getSystemSetting('update_page_url'),
      getSystemSetting('download_channels'),
      loadServiceCatalog(),
    ]);

    let updatePageUrl = envUpdatePageUrl;
    let downloadChannels = envDownloadChannels;
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
      updatePageUrl,
      downloadChannels,
      serviceCatalog,
    };
  } catch {
    return {
      serviceGatewayUrl: envGateway,
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
      const baseCfg = current.serviceCatalog[category];
      const nextCategory: BuiltInServiceCategoryConfig = {
        displayName: typeof incoming.displayName === 'string' ? incoming.displayName : baseCfg.displayName,
        description:
          typeof incoming.description === 'string' ? incoming.description : baseCfg.description,
        defaultSubtaskId: incoming.defaultSubtaskId
          ? sanitizeSubtaskId(incoming.defaultSubtaskId, baseCfg.defaultSubtaskId)
          : baseCfg.defaultSubtaskId,
        subtasks: { ...baseCfg.subtasks },
      };
      if (incoming.subtasks && typeof incoming.subtasks === 'object') {
        for (const [subtaskId, subtaskRaw] of Object.entries(incoming.subtasks)) {
          const safeId = sanitizeSubtaskId(subtaskId);
          if (!safeId) continue;
          const existing = baseCfg.subtasks[safeId];
          let resolvedRaw: Record<string, unknown> = { ...(subtaskRaw as unknown as Record<string, unknown>) };
          if (
            (subtaskRaw as unknown as Record<string, unknown>)?.apiKey === undefined &&
            existing
          ) {
            resolvedRaw.apiKey = existing.apiKey;
          }
          nextCategory.subtasks[safeId] = normalizeSubtaskInput(category, safeId, resolvedRaw, existing);
          nextCategory.subtasks[safeId].updatedAt = new Date().toISOString();
        }
      }
      if (!nextCategory.subtasks[nextCategory.defaultSubtaskId]) {
        nextCategory.defaultSubtaskId = SUBTASK_PRESETS[category][0].id;
      }
      mergedCatalog[category] = nextCategory;
    }
  }

  const merged: BuiltInRuntimeSettings = {
    serviceGatewayUrl: normalizeUrl(input.serviceGatewayUrl || current.serviceGatewayUrl),
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

    await sql`
      CREATE INDEX IF NOT EXISTS idx_service_created_usage ON api_usage_records(service_id, created_at)
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

    // Get today's usage - 使用大小写不敏感匹配，并按北京时间统计用户可见「今日」
    const { rows: dailyRows } = await sql`
      SELECT COUNT(*) as count
      FROM api_usage_records
      WHERE LOWER(user_id) = ${normalizedUserId}
        AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::date
            = (NOW() AT TIME ZONE 'Asia/Shanghai')::date
    `;

    // Get this month's usage - 使用大小写不敏感匹配，并按北京时间统计用户可见「本月」
    const { rows: monthlyRows } = await sql`
      SELECT COUNT(*) as count
      FROM api_usage_records
      WHERE LOWER(user_id) = ${normalizedUserId}
        AND date_trunc('month', (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai'))
            = date_trunc('month', NOW() AT TIME ZONE 'Asia/Shanghai')
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

export async function getUserServiceUsageStats(
  userId: string,
  email?: string
): Promise<BuiltInUsageServiceStat[]> {
  try {
    const normalizedUserId = userId.trim().toLowerCase();
    const normalizedEmail = (email || '').trim().toLowerCase();

    const { rows } = await sql`
      SELECT
        service_id,
        COUNT(CASE WHEN (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::date
                       = (NOW() AT TIME ZONE 'Asia/Shanghai')::date THEN 1 END) as daily_usage,
        COUNT(CASE WHEN date_trunc('month', (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai'))
                       = date_trunc('month', NOW() AT TIME ZONE 'Asia/Shanghai') THEN 1 END) as monthly_usage,
        COUNT(request_id) as total_requests,
        COUNT(CASE WHEN success = true THEN 1 END) as successful_requests,
        COUNT(CASE WHEN success = false THEN 1 END) as failed_requests,
        COALESCE(AVG(NULLIF(response_time, 0))::int, 0) as average_response_time,
        MAX(created_at) as last_used
      FROM api_usage_records
      WHERE LOWER(user_id) = ${normalizedUserId}
        OR (${normalizedEmail} <> '' AND LOWER(user_id) = ${normalizedEmail})
      GROUP BY service_id
    `;

    const map = createServiceUsageMap();
    for (const row of rows) {
      addServiceUsageRow(map, row);
    }
    return finalizeServiceUsageMap(map);
  } catch (error) {
    console.error('Failed to get user service usage stats:', error);
    return finalizeServiceUsageMap(createServiceUsageMap());
  }
}

/**
 * Get all users usage statistics (for admin dashboard)
 * 🔧 FIX: 支持双向ID匹配 - 同时匹配 user_id 和 email 字段
 */
/**
 * Get all users usage statistics (for admin dashboard)
 * 🔧 FIX: 支持双向ID匹配 - 同时匹配 user_id 和 email 字段
 * 🔧 NEW: 返回完整聚合（总请求数/成功数/失败数/平均响应时间/最近使用时间），
 *       让 admin-panel 用户管理面板可以直接渲染单用户统计，而不必依赖
 *       内存里的 service.getUsageStatistics()（serverless / 重启后归零）。
 */
export async function getAllUsersUsageStats(): Promise<Array<{
  userId: string;
  dailyUsage: number;
  monthlyUsage: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageResponseTime: number;
  lastUsed: string | null;
  serviceUsage: BuiltInUsageServiceStat[];
}>> {
  try {
    await ensureAuthorizedUsersTable();
    // Get all users with their usage stats
    // 🔧 FIX: 使用 OR 条件匹配 user_id 或 email，并使用 LOWER 进行大小写不敏感匹配
    const { rows } = await sql`
      SELECT
        u.user_id,
        u.email,
        COUNT(CASE WHEN (r.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::date
                       = (NOW() AT TIME ZONE 'Asia/Shanghai')::date THEN 1 END) as daily_usage,
        COUNT(CASE WHEN date_trunc('month', (r.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai'))
                       = date_trunc('month', NOW() AT TIME ZONE 'Asia/Shanghai') THEN 1 END) as monthly_usage,
        COUNT(r.request_id) as total_requests,
        COUNT(CASE WHEN r.success = true THEN 1 END) as successful_requests,
        COUNT(CASE WHEN r.success = false THEN 1 END) as failed_requests,
        COALESCE(AVG(NULLIF(r.response_time, 0))::int, 0) as average_response_time,
        MAX(r.created_at) as last_used
      FROM authorized_users u
      LEFT JOIN api_usage_records r ON (
        LOWER(u.user_id) = LOWER(r.user_id) OR
        LOWER(u.email) = LOWER(r.user_id)
      )
      WHERE u.status = 'active'
      GROUP BY u.user_id, u.email
    `;

    const { rows: serviceRows } = await sql`
      SELECT
        u.user_id,
        u.email,
        r.service_id,
        COUNT(CASE WHEN (r.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::date
                       = (NOW() AT TIME ZONE 'Asia/Shanghai')::date THEN 1 END) as daily_usage,
        COUNT(CASE WHEN date_trunc('month', (r.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai'))
                       = date_trunc('month', NOW() AT TIME ZONE 'Asia/Shanghai') THEN 1 END) as monthly_usage,
        COUNT(r.request_id) as total_requests,
        COUNT(CASE WHEN r.success = true THEN 1 END) as successful_requests,
        COUNT(CASE WHEN r.success = false THEN 1 END) as failed_requests,
        COALESCE(AVG(NULLIF(r.response_time, 0))::int, 0) as average_response_time,
        MAX(r.created_at) as last_used
      FROM authorized_users u
      LEFT JOIN api_usage_records r ON (
        LOWER(u.user_id) = LOWER(r.user_id) OR
        LOWER(u.email) = LOWER(r.user_id)
      )
      WHERE u.status = 'active'
      GROUP BY u.user_id, u.email, r.service_id
    `;

    const serviceUsageByUser = new Map<string, Map<string, ServiceUsageAccumulator>>();
    for (const row of serviceRows) {
      const userKey = String(row.user_id || '').trim().toLowerCase();
      if (!userKey) continue;
      const map = serviceUsageByUser.get(userKey) || createServiceUsageMap();
      addServiceUsageRow(map, row);
      serviceUsageByUser.set(userKey, map);
    }

    return rows.map(row => ({
      userId: row.user_id,
      dailyUsage: parseInt(row.daily_usage || '0'),
      monthlyUsage: parseInt(row.monthly_usage || '0'),
      totalRequests: parseInt(row.total_requests || '0'),
      successfulRequests: parseInt(row.successful_requests || '0'),
      failedRequests: parseInt(row.failed_requests || '0'),
      averageResponseTime: parseInt(row.average_response_time || '0'),
      lastUsed: row.last_used
        ? (row.last_used instanceof Date
            ? row.last_used.toISOString()
            : String(row.last_used))
        : null,
      serviceUsage: finalizeServiceUsageMap(
        serviceUsageByUser.get(String(row.user_id || '').trim().toLowerCase()) ||
          createServiceUsageMap()
      ),
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
