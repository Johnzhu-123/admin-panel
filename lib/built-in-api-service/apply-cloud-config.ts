/**
 * 内置 AI 服务配置注入器
 *
 * 用途：admin-panel 端 / md2pptWin 服务端 在收到 useBuiltInService=true 的请求时，
 * 从云端 catalog 加载对应类别的 baseUrl/apiKey/model，覆盖 body 中相应字段。
 *
 * 仅服务端使用（依赖 @vercel/postgres）。
 */

import {
  getServiceCatalog,
  type BuiltInServiceCategory,
} from "./db";

export interface BuiltInResolvedConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const RESOLVED_BASE_URL_KEYS = [
  "baseUrl",
  "openAiBaseUrl",
  "geminiBaseUrl",
  "geminiCompatBaseUrl",
];

export async function resolveBuiltInCategoryConfig(
  category: BuiltInServiceCategory
): Promise<BuiltInResolvedConfig | null> {
  try {
    const catalog = await getServiceCatalog();
    const cfg = catalog[category];
    if (!cfg || !cfg.isEnabled) return null;
    if (!cfg.baseUrl || !cfg.apiKey) return null;
    return {
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model || "",
    };
  } catch (error) {
    console.error(
      `[apply-cloud-config] 加载 ${category} catalog 失败:`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

/**
 * 注入 catalog 配置到请求 body：
 * - 若 body 已显式提供 apiKey 且非空，则保留用户配置（仅当 force=true 时覆盖）
 * - 若 body.useBuiltInService 不为 true，直接返回 body
 * - baseUrl/model 同上策略
 */
export function applyBuiltInConfigToBody<T extends Record<string, unknown>>(
  body: T,
  config: BuiltInResolvedConfig | null,
  options: { force?: boolean } = {}
): T {
  if (!config) return body;
  if (body?.useBuiltInService !== true) return body;

  const next: Record<string, unknown> = { ...body };
  const force = options.force === true;

  for (const key of RESOLVED_BASE_URL_KEYS) {
    const current = typeof next[key] === "string" ? (next[key] as string).trim() : "";
    if (force || !current) {
      next[key] = config.baseUrl;
    }
  }

  const currentApiKey = typeof next.apiKey === "string" ? (next.apiKey as string).trim() : "";
  if (force || !currentApiKey) {
    next.apiKey = config.apiKey;
  }

  if (config.model) {
    const currentModel = typeof next.model === "string" ? (next.model as string).trim() : "";
    if (force || !currentModel) {
      next.model = config.model;
    }
  }

  return next as T;
}

/**
 * 一站式：检查 useBuiltInService → 加载 catalog → 注入到 body
 */
export async function injectBuiltInCategoryConfig<T extends Record<string, unknown>>(
  body: T,
  category: BuiltInServiceCategory,
  options: { force?: boolean } = {}
): Promise<{ body: T; applied: boolean; config: BuiltInResolvedConfig | null }> {
  if (body?.useBuiltInService !== true) {
    return { body, applied: false, config: null };
  }
  const config = await resolveBuiltInCategoryConfig(category);
  if (!config) {
    return { body, applied: false, config: null };
  }
  return { body: applyBuiltInConfigToBody(body, config, options), applied: true, config };
}
