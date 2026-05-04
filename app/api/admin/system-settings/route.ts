import { NextResponse } from "next/server";
import { noStoreHeaders } from "@/lib/ai";
import { requireAdminSession } from "@/app/api/admin/_auth";
import { getBuiltInAPIService } from "@/lib/built-in-api-service";
import {
  getBuiltInRuntimeSettings,
  saveBuiltInRuntimeSettings,
  sanitizeServiceCatalog,
  setServiceSubtaskConfig,
  deleteServiceSubtask,
  setCategoryDefaultSubtask,
  getSubtaskPresets,
  getInternalServiceConfig,
  BUILT_IN_SERVICE_CATEGORIES,
  type BuiltInServiceCategory,
  type BuiltInServiceSubtaskConfig,
} from "@/lib/built-in-api-service/db";
import { isEncryptionConfigured } from "@/lib/built-in-api-service/encryption";
import { makeUpstreamTimeout } from "@/lib/built-in-api-service/catalog-resolver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const normalizeUrl = (value?: string) => (value || "").trim().replace(/\/+$/, "");
const normalizeChannelId = (value?: string) =>
  (value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
const normalizeChannelName = (value?: string) => (value || "").trim().slice(0, 40);

const parseDownloadChannels = (raw: unknown) => {
  if (!Array.isArray(raw)) return [] as Array<{ id: string; name: string; url: string }>;
  const seen = new Set<string>();
  const channels: Array<{ id: string; name: string; url: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const url = normalizeUrl(String(record.url || ""));
    if (!/^https?:\/\//i.test(url)) continue;
    const id = normalizeChannelId(String(record.id || "")) || `link_${channels.length + 1}`;
    const name = normalizeChannelName(String(record.name || "")) || id;
    const key = `${id}|${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    channels.push({ id, name, url });
  }
  return channels;
};

const isCategory = (value: unknown): value is BuiltInServiceCategory =>
  typeof value === "string" &&
  (BUILT_IN_SERVICE_CATEGORIES as readonly string[]).includes(value);

/**
 * 判断字符串是否疑似已被 maskSecret 处理过的 API Key。
 * maskSecret 规则：head4 + "*"*max(8, len-8) + tail4，所以正常输出包含 ≥4 个连续 `*`；
 * 同时把"全是星号"的短串也视为 mask（≤8 长度时 mask 全是 `*`）。
 * 真实 API Key 不允许包含 `*` 字符。
 */
const isMaskedApiKey = (value: unknown): boolean => {
  if (typeof value !== "string" || !value) return false;
  if (/\*{4,}/.test(value)) return true;
  if (/^\*+$/.test(value)) return true;
  return false;
};

/**
 * 解析单个 subtask patch；保留只传指定字段的能力，避免覆盖未提供的字段。
 */
const sanitizeSubtaskPatch = (
  raw: unknown
): Partial<Omit<BuiltInServiceSubtaskConfig, "id">> | null => {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof record.displayName === "string") out.displayName = record.displayName.trim();
  if (typeof record.description === "string") out.description = record.description;
  if (typeof record.baseUrl === "string") {
    const baseUrl = normalizeUrl(record.baseUrl);
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) return null;
    out.baseUrl = baseUrl;
  }
  if (typeof record.apiKey === "string") {
    // 防御：拒绝把 mask 字符串（如 "abcd********wxyz"）当作真实 key 写入数据库；
    // 客户端若发回 mask（用户没改 apiKey 字段），应静默跳过保留原有真实值。
    if (!isMaskedApiKey(record.apiKey)) {
      out.apiKey = record.apiKey;
    }
  }
  if (typeof record.model === "string") out.model = record.model.trim();
  // 🔧 NEW (2026-05 #21): 接受 models 数组（每条 trim、去空、去重；非数组直接忽略）
  if (Array.isArray(record.models)) {
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const item of record.models) {
      const t = typeof item === "string" ? item.trim() : "";
      if (!t || seen.has(t)) continue;
      seen.add(t);
      cleaned.push(t);
    }
    out.models = cleaned;
  }
  if (typeof record.isEnabled === "boolean") out.isEnabled = record.isEnabled;
  return out as Partial<Omit<BuiltInServiceSubtaskConfig, "id">>;
};

function buildResponseSettings(settings: Awaited<ReturnType<typeof getBuiltInRuntimeSettings>>) {
  return {
    ...settings,
    serviceCatalog: sanitizeServiceCatalog(settings.serviceCatalog, { includeKeyMask: true }),
    subtaskPresets: getSubtaskPresets(),
  };
}

async function clearBuiltInServiceCaches(reason: string) {
  try {
    const builtInService = getBuiltInAPIService();
    await builtInService.initialize();
    builtInService.clearCaches();
    console.log(`[system-settings] Cleared built-in service caches after ${reason}`);
  } catch (error) {
    console.warn(
      `[system-settings] Failed to clear built-in service caches after ${reason}:`,
      error instanceof Error ? error.message : error
    );
  }
}

export async function GET() {
  const unauthorized = await requireAdminSession();
  if (unauthorized) return unauthorized;
  try {
    const settings = await getBuiltInRuntimeSettings();
    return NextResponse.json(
      {
        settings: buildResponseSettings(settings),
        encryption: { configured: isEncryptionConfigured() },
      },
      { headers: noStoreHeaders() }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load settings" },
      { status: 500, headers: noStoreHeaders() }
    );
  }
}

export async function POST(req: Request) {
  const unauthorized = await requireAdminSession();
  if (unauthorized) return unauthorized;
  try {
    const body = await req.json();
    const action = typeof body?.action === "string" ? body.action : "replace";

    /**
     * 更新某 category 下的某个 subtask
     * body: { action, category, subtaskId, patch }
     */
    if (action === "update-service-subtask") {
      const category = body?.category;
      if (!isCategory(category)) {
        return NextResponse.json(
          { error: `category must be one of ${BUILT_IN_SERVICE_CATEGORIES.join("|")}` },
          { status: 400, headers: noStoreHeaders() }
        );
      }
      const subtaskId = String(body?.subtaskId || "").trim();
      if (!subtaskId) {
        return NextResponse.json(
          { error: "subtaskId is required" },
          { status: 400, headers: noStoreHeaders() }
        );
      }
      const patch = sanitizeSubtaskPatch(body?.patch);
      if (!patch || Object.keys(patch).length === 0) {
        return NextResponse.json(
          { error: "patch is empty or invalid" },
          { status: 400, headers: noStoreHeaders() }
        );
      }
      await setServiceSubtaskConfig(category, subtaskId, patch);
      await clearBuiltInServiceCaches("update-service-subtask");
      const settings = await getBuiltInRuntimeSettings();
      return NextResponse.json(
        { settings: buildResponseSettings(settings) },
        { headers: noStoreHeaders() }
      );
    }

    /**
     * 删除自定义 subtask（预设 ID 拒绝）
     * body: { action, category, subtaskId }
     */
    if (action === "delete-service-subtask") {
      const category = body?.category;
      if (!isCategory(category)) {
        return NextResponse.json(
          { error: `category must be one of ${BUILT_IN_SERVICE_CATEGORIES.join("|")}` },
          { status: 400, headers: noStoreHeaders() }
        );
      }
      const subtaskId = String(body?.subtaskId || "").trim();
      if (!subtaskId) {
        return NextResponse.json(
          { error: "subtaskId is required" },
          { status: 400, headers: noStoreHeaders() }
        );
      }
      await deleteServiceSubtask(category, subtaskId);
      await clearBuiltInServiceCaches("delete-service-subtask");
      const settings = await getBuiltInRuntimeSettings();
      return NextResponse.json(
        { settings: buildResponseSettings(settings) },
        { headers: noStoreHeaders() }
      );
    }

    /**
     * 设置某 category 默认 subtask
     * body: { action, category, subtaskId }
     */
    if (action === "set-default-subtask") {
      const category = body?.category;
      if (!isCategory(category)) {
        return NextResponse.json(
          { error: `category must be one of ${BUILT_IN_SERVICE_CATEGORIES.join("|")}` },
          { status: 400, headers: noStoreHeaders() }
        );
      }
      const subtaskId = String(body?.subtaskId || "").trim();
      if (!subtaskId) {
        return NextResponse.json(
          { error: "subtaskId is required" },
          { status: 400, headers: noStoreHeaders() }
        );
      }
      await setCategoryDefaultSubtask(category, subtaskId);
      await clearBuiltInServiceCaches("set-default-subtask");
      const settings = await getBuiltInRuntimeSettings();
      return NextResponse.json(
        { settings: buildResponseSettings(settings) },
        { headers: noStoreHeaders() }
      );
    }

    /**
     * 探测一个 subtask 的连通性并拉取上游模型列表。
     *
     * body: {
     *   action: "probe-subtask",
     *   category: BuiltInServiceCategory,
     *   subtaskId: string,
     *   baseUrl?: string,    // 未传时用 catalog 已存的
     *   apiKey?: string,     // 未传或以 "****" 开头时用 catalog 已存的真值
     * }
     *
     * 返回: { ok, status, models: string[], error?: string, baseUrl, source }
     *
     * 用途：管理员在 UI 里测试连通性 + 自动填充 model datalist。
     */
    if (action === "probe-subtask") {
      const category = body?.category;
      if (!isCategory(category)) {
        return NextResponse.json(
          { error: `category must be one of ${BUILT_IN_SERVICE_CATEGORIES.join("|")}` },
          { status: 400, headers: noStoreHeaders() }
        );
      }
      const subtaskId = String(body?.subtaskId || "").trim();
      if (!subtaskId) {
        return NextResponse.json(
          { error: "subtaskId is required" },
          { status: 400, headers: noStoreHeaders() }
        );
      }

      const explicitBaseUrl =
        typeof body?.baseUrl === "string" ? normalizeUrl(body.baseUrl) : "";
      const explicitApiKey = typeof body?.apiKey === "string" ? body.apiKey : "";
      const apiKeyIsMasked = isMaskedApiKey(explicitApiKey);

      let baseUrl = "";
      let apiKey = "";
      let source: "input" | "stored" | "mixed" = "input";
      const stored = await getInternalServiceConfig(category, subtaskId);
      if (explicitBaseUrl) {
        baseUrl = explicitBaseUrl;
      } else if (stored?.subtask?.baseUrl) {
        baseUrl = stored.subtask.baseUrl;
        source = "stored";
      }
      if (explicitApiKey && !apiKeyIsMasked) {
        apiKey = explicitApiKey;
      } else if (stored?.subtask?.apiKey) {
        apiKey = stored.subtask.apiKey;
        source = source === "stored" ? "stored" : "mixed";
      }

      if (!baseUrl) {
        return NextResponse.json(
          { ok: false, error: "BaseURL 为空（既未提供也未在 catalog 找到）" },
          { status: 400, headers: noStoreHeaders() }
        );
      }
      if (!/^https?:\/\//i.test(baseUrl)) {
        return NextResponse.json(
          { ok: false, error: "BaseURL 必须以 http:// 或 https:// 开头" },
          { status: 400, headers: noStoreHeaders() }
        );
      }
      if (!apiKey) {
        return NextResponse.json(
          { ok: false, error: "API Key 为空（既未提供也未在 catalog 找到）" },
          { status: 400, headers: noStoreHeaders() }
        );
      }

      const modelsUrl = /\/v\d+(?:\/|$)/i.test(baseUrl)
        ? `${baseUrl.replace(/\/+$/, "")}/models`
        : `${baseUrl.replace(/\/+$/, "")}/v1/models`;

      const upstream = makeUpstreamTimeout(15000);
      try {
        const res = await fetch(modelsUrl, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
          },
          signal: upstream.signal,
        });
        upstream.cancel();

        const text = await res.text().catch(() => "");
        let parsed: unknown = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = null;
        }

        if (!res.ok) {
          const data = parsed as { error?: { message?: string } | string; message?: string } | null;
          const rawMessage =
            (typeof data?.error === "string" && data.error) ||
            (typeof data?.error === "object" && data.error?.message) ||
            (typeof data?.message === "string" && data.message) ||
            text.slice(0, 200) ||
            `HTTP ${res.status}`;

          // Fallback：当 /v1/models 被上游单独限权（常见 401/403/404）时，
          // 改用 POST /v1/chat/completions 做最小请求来验证 API Key 是否有效。
          // 思路：上游若收到 auth 错误一律返回 401/403；模型不存在/参数错误则
          // 返回 400/404/422 等——这些都意味着 key 已被识别为合法。
          const shouldFallback = [401, 403, 404].includes(res.status);
          if (shouldFallback) {
            const chatUrl = /\/v\d+(?:\/|$)/i.test(baseUrl)
              ? `${baseUrl.replace(/\/+$/, "")}/chat/completions`
              : `${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
            const chatUpstream = makeUpstreamTimeout(15000);
            try {
              const chatRes = await fetch(chatUrl, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${apiKey}`,
                  "Content-Type": "application/json",
                  Accept: "application/json",
                },
                body: JSON.stringify({
                  model: "__probe__",
                  messages: [{ role: "user", content: "ping" }],
                  max_tokens: 1,
                  stream: false,
                }),
                signal: chatUpstream.signal,
              });
              chatUpstream.cancel();
              const chatText = await chatRes.text().catch(() => "");

              if (![401, 403].includes(chatRes.status)) {
                // auth 通过，但取不到模型列表，提示用户手填 model
                return NextResponse.json(
                  {
                    ok: true,
                    status: res.status,
                    models: [],
                    baseUrl,
                    source,
                    modelsUrl,
                    authVerifiedVia: "chat",
                    notice: `上游 /models 端点拒绝该 Key（HTTP ${res.status}：${rawMessage}）；已通过 POST /chat/completions 验证 Key 可用，请手动填写 Model 名称。`,
                  },
                  { headers: noStoreHeaders() }
                );
              }

              // chat 也是 401/403：把原 models 的错误返还
              let chatParsed: unknown = null;
              try {
                chatParsed = chatText ? JSON.parse(chatText) : null;
              } catch {
                chatParsed = null;
              }
              const chatData = chatParsed as { error?: { message?: string } | string; message?: string } | null;
              const chatMsg =
                (typeof chatData?.error === "string" && chatData.error) ||
                (typeof chatData?.error === "object" && chatData.error?.message) ||
                (typeof chatData?.message === "string" && chatData.message) ||
                chatText.slice(0, 200) ||
                `HTTP ${chatRes.status}`;
              return NextResponse.json(
                {
                  ok: false,
                  status: res.status,
                  error: `上游返回 HTTP ${res.status}：${rawMessage}（chat 兜底也失败：HTTP ${chatRes.status}：${chatMsg}）`,
                  baseUrl,
                  source,
                  modelsUrl,
                  fallbackTried: "chat",
                },
                { headers: noStoreHeaders() }
              );
            } catch (chatErr: unknown) {
              chatUpstream.cancel();
              return NextResponse.json(
                {
                  ok: false,
                  status: res.status,
                  error: `上游返回 HTTP ${res.status}：${rawMessage}（chat 兜底请求异常：${chatErr instanceof Error ? chatErr.message : String(chatErr)}）`,
                  baseUrl,
                  source,
                  modelsUrl,
                  fallbackTried: "chat",
                },
                { headers: noStoreHeaders() }
              );
            }
          }

          return NextResponse.json(
            {
              ok: false,
              status: res.status,
              error: `上游返回 HTTP ${res.status}：${rawMessage}`,
              baseUrl,
              source,
              modelsUrl,
            },
            { headers: noStoreHeaders() }
          );
        }

        const data = parsed as { data?: unknown[]; models?: unknown[] } | null;
        const items: unknown[] = Array.isArray(data?.data)
          ? data!.data
          : Array.isArray(data?.models)
            ? data!.models
            : [];
        const models = Array.from(
          new Set(
            items
              .map((item: unknown) => {
                if (typeof item === "string") return item.trim();
                if (item && typeof item === "object") {
                  const rec = item as Record<string, unknown>;
                  return (
                    (typeof rec.id === "string" && rec.id.trim()) ||
                    (typeof rec.name === "string" && rec.name.trim()) ||
                    (typeof rec.model === "string" && rec.model.trim()) ||
                    ""
                  );
                }
                return "";
              })
              .filter(Boolean) as string[]
          )
        ).sort();

        return NextResponse.json(
          {
            ok: true,
            status: res.status,
            models,
            baseUrl,
            source,
            modelsUrl,
          },
          { headers: noStoreHeaders() }
        );
      } catch (fetchError: unknown) {
        upstream.cancel();
        const isAbort =
          fetchError instanceof Error && fetchError.name === "AbortError";
        return NextResponse.json(
          {
            ok: false,
            status: isAbort ? 504 : 0,
            error: isAbort
              ? `上游 15 秒内无响应（${baseUrl}）。请检查 BaseURL 是否仍可达。`
              : `上游不可达：${fetchError instanceof Error ? fetchError.message : String(fetchError)}`,
            baseUrl,
            source,
            modelsUrl,
          },
          { status: 504, headers: noStoreHeaders() }
        );
      }
    }

    /**
     * 一键应用通用凭据：把同一份 baseUrl + apiKey 写入指定 categories 下的所有 subtask。
     * body: {
     *   action: "bulk-apply-credentials",
     *   baseUrl?: string,
     *   apiKey?: string,
     *   isEnabled?: boolean,
     *   categories?: BuiltInServiceCategory[],   // 默认所有 5 类
     *   subtaskIds?: Record<category, string[]>, // 可选，只写入指定 subtask；缺省=全部
     * }
     * 任一字段未提供则不覆盖；空字符串视为"清空"。
     */
    if (action === "bulk-apply-credentials") {
      const rawBaseUrl =
        typeof body?.baseUrl === "string" ? normalizeUrl(body.baseUrl) : undefined;
      if (typeof body?.baseUrl === "string" && rawBaseUrl && !/^https?:\/\//i.test(rawBaseUrl)) {
        return NextResponse.json(
          { error: "baseUrl must start with http:// or https://" },
          { status: 400, headers: noStoreHeaders() }
        );
      }
      const rawApiKey = typeof body?.apiKey === "string" ? body.apiKey : undefined;
      if (rawApiKey !== undefined && isMaskedApiKey(rawApiKey)) {
        return NextResponse.json(
          { error: "apiKey 看起来是掩码字符串（含连续 *），请填写真实 Key 或留空" },
          { status: 400, headers: noStoreHeaders() }
        );
      }
      const rawIsEnabled =
        typeof body?.isEnabled === "boolean" ? body.isEnabled : undefined;

      const categoriesInput = Array.isArray(body?.categories)
        ? (body.categories as unknown[]).filter(isCategory)
        : [];
      const targetCategories: BuiltInServiceCategory[] = categoriesInput.length
        ? (categoriesInput as BuiltInServiceCategory[])
        : ([...BUILT_IN_SERVICE_CATEGORIES] as BuiltInServiceCategory[]);

      const subtaskIdsMap =
        body?.subtaskIds && typeof body.subtaskIds === "object"
          ? (body.subtaskIds as Record<string, unknown>)
          : null;

      const currentSettings = await getBuiltInRuntimeSettings();
      const catalog = currentSettings.serviceCatalog;
      let applied = 0;

      for (const category of targetCategories) {
        const cfg = catalog[category];
        if (!cfg) continue;
        const allSubtaskIds = Object.keys(cfg.subtasks);
        const filterIds = subtaskIdsMap
          ? Array.isArray(subtaskIdsMap[category])
            ? (subtaskIdsMap[category] as unknown[]).map(String)
            : null
          : null;
        const targetIds = filterIds
          ? allSubtaskIds.filter((id) => filterIds.includes(id))
          : allSubtaskIds;
        for (const subtaskId of targetIds) {
          const patch: Partial<Omit<BuiltInServiceSubtaskConfig, "id">> = {};
          if (rawBaseUrl !== undefined) patch.baseUrl = rawBaseUrl;
          if (rawApiKey !== undefined) patch.apiKey = rawApiKey;
          if (rawIsEnabled !== undefined) patch.isEnabled = rawIsEnabled;
          if (Object.keys(patch).length === 0) continue;
          await setServiceSubtaskConfig(category, subtaskId, patch);
          applied += 1;
        }
      }

      await clearBuiltInServiceCaches("bulk-apply-credentials");
      const settings = await getBuiltInRuntimeSettings();
      return NextResponse.json(
        { settings: buildResponseSettings(settings), applied },
        { headers: noStoreHeaders() }
      );
    }

    /**
     * 全量替换运行时设置（serviceGatewayUrl + updatePageUrl + downloadChannels）。
     * 不支持通过此接口批量更新 catalog（catalog 必须用 update-service-subtask）
     */
    const serviceGatewayUrl = normalizeUrl(body?.serviceGatewayUrl || "");
    const updatePageUrl = normalizeUrl(body?.updatePageUrl || "");
    const downloadChannels = parseDownloadChannels(body?.downloadChannels);

    if (serviceGatewayUrl && !/^https?:\/\//i.test(serviceGatewayUrl)) {
      return NextResponse.json(
        { error: "serviceGatewayUrl must start with http:// or https://" },
        { status: 400, headers: noStoreHeaders() }
      );
    }
    if (updatePageUrl && !/^https?:\/\//i.test(updatePageUrl)) {
      return NextResponse.json(
        { error: "updatePageUrl must start with http:// or https://" },
        { status: 400, headers: noStoreHeaders() }
      );
    }

    const settings = await saveBuiltInRuntimeSettings({
      serviceGatewayUrl,
      updatePageUrl,
      downloadChannels,
    });

    await clearBuiltInServiceCaches("save-runtime-settings");
    return NextResponse.json(
      { settings: buildResponseSettings(settings) },
      { headers: noStoreHeaders() }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save settings" },
      { status: 500, headers: noStoreHeaders() }
    );
  }
}
