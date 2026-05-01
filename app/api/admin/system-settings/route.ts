import { NextResponse } from "next/server";
import { noStoreHeaders } from "@/lib/ai";
import { requireAdminSession } from "@/app/api/admin/_auth";
import {
  getBuiltInRuntimeSettings,
  saveBuiltInRuntimeSettings,
  sanitizeServiceCatalog,
  setServiceSubtaskConfig,
  deleteServiceSubtask,
  setCategoryDefaultSubtask,
  getSubtaskPresets,
  BUILT_IN_SERVICE_CATEGORIES,
  type BuiltInServiceCategory,
  type BuiltInServiceCatalog,
  type BuiltInServiceSubtaskConfig,
} from "@/lib/built-in-api-service/db";
import { isEncryptionConfigured } from "@/lib/built-in-api-service/encryption";

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
  if (typeof record.apiKey === "string") out.apiKey = record.apiKey;
  if (typeof record.model === "string") out.model = record.model.trim();
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
      const settings = await getBuiltInRuntimeSettings();
      return NextResponse.json(
        { settings: buildResponseSettings(settings) },
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
