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
  // 🔧 FIX (2026-06-11 BUG-D2): 用户请求的模型不在子任务允许列表时回退到
  //   subtask.model，并用该标记告知调用方发生了回退。
  modelFallback?: boolean;
}

/**
 * 🔧 FIX (2026-06-11 BUG-D2): 在 subtask 允许范围内挑选最终生效的模型。
 *   requestedModel 非空且命中（=== subtask.model 或 ∈ subtask.models[]）→ 用 requestedModel；
 *   非空但未命中 → 回退 subtask.model 并标记 modelFallback=true；
 *   为空 → 直接用 subtask.model（不算回退）。
 *   该逻辑同时供 catalog-resolver（plan/summary/image/models 路由）与本文件
 *   （tts/video 等价调用点）使用。
 */
export function pickAllowedModel(
  subtask: { model?: string; models?: string[] },
  requestedModel?: string
): { model: string; modelFallback: boolean } {
  const defaultModel = (subtask.model || "").trim();
  const requested = (requestedModel || "").trim();
  if (!requested) return { model: defaultModel, modelFallback: false };
  const allowed = Array.isArray(subtask.models)
    ? subtask.models.map((m) => (m || "").trim()).filter(Boolean)
    : [];
  const hit = requested === defaultModel || allowed.includes(requested);
  return hit
    ? { model: requested, modelFallback: false }
    : { model: defaultModel, modelFallback: true };
}

const RESOLVED_BASE_URL_KEYS = [
  "baseUrl",
  "openAiBaseUrl",
  "geminiBaseUrl",
  "geminiCompatBaseUrl",
];

export async function resolveBuiltInCategoryConfig(
  category: BuiltInServiceCategory,
  subtaskId?: string,
  // 🔧 FIX (2026-06-11 BUG-D2): 透传用户请求的模型，命中允许列表时生效
  requestedModel?: string
): Promise<BuiltInResolvedConfig | null> {
  try {
    const entry = await getInternalServiceConfig(category, subtaskId);
    if (!entry) return null;
    const { subtask } = entry;
    if (!subtask.isEnabled) return null;
    if (!subtask.baseUrl || !subtask.apiKey) return null;
    const { model, modelFallback } = pickAllowedModel(subtask, requestedModel);
    return {
      baseUrl: subtask.baseUrl,
      apiKey: subtask.apiKey,
      model,
      subtaskId: subtask.id,
      endpointPath: subtask.endpointPath || undefined,
      ...(modelFallback ? { modelFallback: true } : {}),
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
 * - 内置模式的 BaseURL/API key 必须始终成对来自 catalog，禁止把服务器密钥
 *   与调用方提供的公网地址组合，否则会形成凭据外泄。
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
  for (const key of RESOLVED_BASE_URL_KEYS) {
    next[key] = config.baseUrl;
  }
  next.apiKey = config.apiKey;

  if (config.model) {
    const currentModel = typeof next.model === "string" ? (next.model as string).trim() : "";
    // 🔧 FIX (2026-06-11 BUG-D2): modelFallback=true 表示 body 里用户请求的模型
    //   未通过允许列表校验，必须用回退后的 config.model 覆盖，否则无效模型会被
    //   原样发往上游。
    if (!currentModel || config.modelFallback === true || options.force === true) {
      next.model = config.model;
    }
  }

  return next as T;
}

/**
 * 一站式：检查 useBuiltInService → 加载 catalog → 注入到 body
 * 可通过 body.builtInSubtaskId 显式选择子任务（缺省走该 category 的 default）
 * 🔧 FIX (2026-06-11 BUG-D2): 新增 options.requestedModel，把用户所选模型透传给
 *   catalog 解析，命中 subtask.model/models[] 时按用户所选返回。
 */
export async function injectBuiltInCategoryConfig<T extends Record<string, unknown>>(
  body: T,
  category: BuiltInServiceCategory,
  options: { force?: boolean; subtaskId?: string; requestedModel?: string } = {}
): Promise<{ body: T; applied: boolean; config: BuiltInResolvedConfig | null }> {
  if (body?.useBuiltInService !== true) {
    return { body, applied: false, config: null };
  }
  const subtaskHint =
    options.subtaskId ||
    (typeof body?.builtInSubtaskId === "string" ? (body.builtInSubtaskId as string) : undefined);
  // 🔧 FIX (2026-06-11 BUG-D2): requestedModel 仅显式传入时参与校验，
  //   未传的调用方（如 analyze-materials）保持旧行为不受影响。
  const config = await resolveBuiltInCategoryConfig(
    category,
    subtaskHint,
    options.requestedModel
  );
  if (!config) {
    return { body, applied: false, config: null };
  }
  return { body: applyBuiltInConfigToBody(body, config, options), applied: true, config };
}
