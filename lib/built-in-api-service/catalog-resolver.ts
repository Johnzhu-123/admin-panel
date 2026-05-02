/**
 * Catalog 优先的内置服务凭据解析器
 *
 * 历史背景：早期 admin-panel 通过 `getBuiltInServiceConfig`（环境变量）获取内置服务的
 * baseUrl + apiKey。重构后改为由管理员在 UI 服务目录里按 5 大类×N 子任务配置 catalog，
 * 但 `/api/ai/{models,plan,summary,image}` 仍然走旧 env 配置，导致用户在 UI 里改了
 * baseUrl/apiKey 后这 4 条路由仍然请求旧上游（已下线的 zeabur 域）→ Cloudflare 530。
 *
 * 本文件提供统一封装：先按指定 category 从 catalog 取真实 baseUrl + apiKey，
 * 缺失时再 fallback 到 env config，确保 UI 里的修改对所有路由生效。
 *
 * 性能要点：原先依赖 service-manager 的 getAvailableServices 链路（涉及 5+ 次 DB 往返
 * 与 isServiceAvailable validation），实测在 Render 免费 Postgres 上单次解析 4-8 秒，
 * 桌面端 20 秒 timeout 内做不完 5 个分类。新实现压缩到 2 次 DB 调用：
 *   1. checkUserAuthorization(userId)  — authorized_users 单行查询
 *   2. getInternalServiceConfig(category, subtaskId) — 单次 catalog 加载
 */
import { BuiltInServiceConfig } from "./types";
import { getBuiltInAPIService } from "./index";
import {
  getInternalServiceConfig,
  type BuiltInServiceCategory,
} from "./db";

export type ResolvedBuiltInConfig = BuiltInServiceConfig & {
  source: "catalog" | "env";
  category: BuiltInServiceCategory;
  subtaskId?: string;
};

const ZERO_QUOTA = {
  dailyRequests: 0,
  monthlyRequests: 0,
  concurrentRequests: 0,
} as const;

const ZERO_RATE = {
  requestsPerMinute: 0,
  requestsPerHour: 0,
  burstLimit: 0,
} as const;

/**
 * 解析授权用户对应分类的内置服务凭据。
 *
 * 流程：
 * 1. 鉴权（authorized_users + can_use_built_in_services）
 * 2. 直接从 catalog 取 baseUrl/apiKey/model（catalog 优先）
 *
 * @returns 失败时返回 null（未授权 / catalog 未配 baseUrl+apiKey）
 */
export async function resolveBuiltInWithCatalog(
  userId: string,
  category: BuiltInServiceCategory,
  subtaskId?: string
): Promise<ResolvedBuiltInConfig | null> {
  if (!userId) return null;
  try {
    const builtInService = getBuiltInAPIService();
    await builtInService.initialize();

    const isAuthorized = await builtInService.checkUserAuthorization(userId);
    if (!isAuthorized) return null;

    const catalogEntry = await getInternalServiceConfig(category, subtaskId);
    const subtask = catalogEntry?.subtask;
    if (!subtask) return null;

    const baseUrl = (subtask.baseUrl || "").trim();
    const apiKey = (subtask.apiKey || "").trim();
    if (!baseUrl || !apiKey) return null;

    return {
      id: `built-in-${category}-${subtask.id}`,
      name: process.env.BUILT_IN_SERVICE_NAME || "内置服务",
      provider: "openai",
      isEnabled: subtask.isEnabled !== false,
      apiKey,
      baseUrl,
      model: (subtask.model || "").trim(),
      quotaLimits: { ...ZERO_QUOTA },
      rateLimits: { ...ZERO_RATE },
      createdAt: new Date(),
      updatedAt: new Date(),
      source: "catalog",
      category,
      subtaskId: subtask.id,
    };
  } catch {
    return null;
  }
}

/**
 * 把 fetch 上游时遇到的 Cloudflare 530 / 521 / 522 / 523 / 524 错误改写成中文友好提示。
 * 其他状态码透传原始 message。
 */
export function rewriteUpstreamError(
  status: number,
  rawMessage: string,
  category: BuiltInServiceCategory
): string {
  const trimmed = (rawMessage || "").trim();
  if (status === 530) {
    return `内置服务上游网关已下线（${category} 分类）。请在管理面板 → 服务目录里把 ${category} 子任务的 BaseURL 改成可用的上游 API（530 The origin has been unregistered from Argo Tunnel）。`;
  }
  if (status === 521 || status === 522 || status === 523 || status === 524) {
    return `内置服务上游网关连接失败（${category} 分类，HTTP ${status}）。请检查 BaseURL 是否仍可访问，或在管理面板更换上游。`;
  }
  if (status === 401 || status === 403) {
    return `内置服务上游 API Key 无效或权限不足（${category} 分类，HTTP ${status}）。请在管理面板更新 ${category} 子任务的 API Key。`;
  }
  if (status === 404) {
    return `内置服务上游路径不存在（${category} 分类，HTTP ${status}）。请检查 BaseURL 路径格式（应以 /v1 结尾，如 https://example.com/v1）。`;
  }
  return trimmed || `内置服务请求失败（${category} 分类，HTTP ${status}）`;
}

/**
 * 创建一个绑定 timeout 的 AbortSignal，避免 admin-panel 在等不响应的上游时被桌面端先超时。
 * 默认 15 秒比桌面端 /api/ai/models 的 60s 短，先在服务端拿到清晰错误再返回。
 */
export function makeUpstreamTimeout(ms = 15000): {
  signal: AbortSignal;
  cancel: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}

