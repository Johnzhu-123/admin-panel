import { NextResponse } from "next/server";
import { noStoreHeaders } from "@/lib/ai";
import { requireAdminSession } from "@/app/api/admin/_auth";
import {
  getBuiltInRuntimeSettings,
  saveBuiltInRuntimeSettings,
  sanitizeServiceCatalog,
  setServiceCategoryConfig,
  BUILT_IN_SERVICE_CATEGORIES,
  type BuiltInServiceCategory,
  type BuiltInServiceCatalog,
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

const parseUrls = (raw: unknown) => {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => normalizeUrl(String(item || "")))
      .filter((item) => /^https?:\/\//i.test(item));
  }
  const text = typeof raw === "string" ? raw : "";
  return text
    .split(/[\n,;]/)
    .map((item) => normalizeUrl(item))
    .filter((item) => /^https?:\/\//i.test(item));
};

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

const sanitizeCatalogInput = (raw: unknown): Partial<BuiltInServiceCatalog> | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  const result: Partial<BuiltInServiceCatalog> = {};
  for (const category of BUILT_IN_SERVICE_CATEGORIES) {
    const incoming = (raw as Record<string, unknown>)[category];
    if (!incoming || typeof incoming !== "object") continue;
    const record = incoming as Record<string, unknown>;
    const baseUrl = normalizeUrl(String(record.baseUrl || ""));
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) continue;
    const apiKey = typeof record.apiKey === "string" ? record.apiKey : undefined;
    const model = typeof record.model === "string" ? record.model.trim() : undefined;
    const isEnabled =
      typeof record.isEnabled === "boolean" ? record.isEnabled : undefined;
    const next: Record<string, unknown> = {};
    if (baseUrl !== undefined) next.baseUrl = baseUrl;
    if (apiKey !== undefined && apiKey !== "") next.apiKey = apiKey;
    if (model !== undefined) next.model = model;
    if (isEnabled !== undefined) next.isEnabled = isEnabled;
    result[category] = next as unknown as BuiltInServiceCatalog[BuiltInServiceCategory];
  }
  return Object.keys(result).length ? result : undefined;
};

function buildResponseSettings(settings: Awaited<ReturnType<typeof getBuiltInRuntimeSettings>>) {
  return {
    ...settings,
    serviceCatalog: sanitizeServiceCatalog(settings.serviceCatalog, { includeKeyMask: true }),
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

    if (action === "append-iopaint-urls" || action === "remove-iopaint-urls") {
      const current = await getBuiltInRuntimeSettings();
      const targetUrls = parseUrls(body?.iopaintUrls);

      if (!targetUrls.length) {
        return NextResponse.json(
          { error: "iopaintUrls is empty" },
          { status: 400, headers: noStoreHeaders() }
        );
      }

      let nextUrls: string[] = current.iopaintUrls || [];
      if (action === "append-iopaint-urls") {
        nextUrls = Array.from(new Set([...nextUrls, ...targetUrls]));
      } else {
        const removeSet = new Set(targetUrls);
        nextUrls = nextUrls.filter((item) => !removeSet.has(normalizeUrl(item)));
      }

      const settings = await saveBuiltInRuntimeSettings({
        serviceGatewayUrl: current.serviceGatewayUrl,
        iopaintUrls: nextUrls,
        updatePageUrl: current.updatePageUrl,
        downloadChannels: current.downloadChannels,
      });
      return NextResponse.json(
        { settings: buildResponseSettings(settings) },
        { headers: noStoreHeaders() }
      );
    }

    if (action === "update-service-category") {
      const category = body?.category;
      if (!isCategory(category)) {
        return NextResponse.json(
          { error: `category must be one of ${BUILT_IN_SERVICE_CATEGORIES.join("|")}` },
          { status: 400, headers: noStoreHeaders() }
        );
      }
      const patch = body?.patch;
      const sanitized = sanitizeCatalogInput({ [category]: patch })?.[category];
      if (!sanitized) {
        return NextResponse.json(
          { error: "patch is empty or invalid" },
          { status: 400, headers: noStoreHeaders() }
        );
      }
      await setServiceCategoryConfig(category, sanitized);
      const settings = await getBuiltInRuntimeSettings();
      return NextResponse.json(
        { settings: buildResponseSettings(settings) },
        { headers: noStoreHeaders() }
      );
    }

    const serviceGatewayUrl = normalizeUrl(body?.serviceGatewayUrl || "");
    const iopaintUrls = parseUrls(body?.iopaintUrls);
    const updatePageUrl = normalizeUrl(body?.updatePageUrl || "");
    const downloadChannels = parseDownloadChannels(body?.downloadChannels);
    const serviceCatalogPatch = sanitizeCatalogInput(body?.serviceCatalog);

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
      iopaintUrls,
      updatePageUrl,
      downloadChannels,
      serviceCatalog: serviceCatalogPatch as BuiltInServiceCatalog | undefined,
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
