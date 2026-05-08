/**
 * 内置 AI 服务配置注入器（subtask 版）
 *
 * 用途：md2pptWin 服务端 AI 路由收到 useBuiltInService=true 的请求时，
 * 从云端 catalog 加载对应类别 + subtask 的 baseUrl/apiKey/model，覆盖 body 字段。
 *
 * 仅服务端使用（依赖 @vercel/postgres）。
 */

import {
  getInternalServiceConfig,
  type BuiltInServiceCategory,
} from "./db";

export interface BuiltInResolvedConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  subtaskId: string;
  // 🔧 NEW (2026-05 #24): video category 专用 — 上游视频接口路径（如 /v1/videos）。
  //   仅 video route 会读取；其它 category 忽略。
  endpointPath?: string;
}

const RESOLVED_BASE_URL_KEYS = [
  "baseUrl",
  "openAiBaseUrl",
  "geminiBaseUrl",
  "geminiCompatBaseUrl",
];

export async function resolveBuiltInCategoryConfig(
  category: BuiltInServiceCategory,
  subtaskId?: string
): Promise<BuiltInResolvedConfig | null> {
  try {
    const entry = await getInternalServiceConfig(category, subtaskId);
    if (!entry) return null;
    const { subtask } = entry;
    if (!subtask.isEnabled) return null;
    if (!subtask.baseUrl || !subtask.apiKey) return null;
    return {
      baseUrl: subtask.baseUrl,
      apiKey: subtask.apiKey,
      model: subtask.model || "",
      subtaskId: subtask.id,
      endpointPath: subtask.endpointPath || undefined,
    };
  } catch (error) {
    console.error(
      `[apply-cloud-config] 加载 ${category}/${subtaskId || "default"} 失败:`,
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
 * 可通过 body.builtInSubtaskId 显式选择子任务（缺省走该 category 的 default）
 */
export async function injectBuiltInCategoryConfig<T extends Record<string, unknown>>(
  body: T,
  category: BuiltInServiceCategory,
  options: { force?: boolean; subtaskId?: string } = {}
): Promise<{ body: T; applied: boolean; config: BuiltInResolvedConfig | null }> {
  if (body?.useBuiltInService !== true) {
    return { body, applied: false, config: null };
  }
  const subtaskHint =
    options.subtaskId ||
    (typeof body?.builtInSubtaskId === "string" ? (body.builtInSubtaskId as string) : undefined);
  const config = await resolveBuiltInCategoryConfig(category, subtaskHint);
  if (!config) {
    return { body, applied: false, config: null };
  }
  return { body: applyBuiltInConfigToBody(body, config, options), applied: true, config };
}
