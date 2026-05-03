import { requireAdminSession } from "@/app/api/admin/_auth";
import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { noStoreHeaders } from "@/lib/ai";
import {
  BUILT_IN_SERVICE_CATEGORIES,
  getBuiltInRuntimeSettings,
  initializeSystemSettingsTable,
} from "@/lib/built-in-api-service/db";
import { isEncryptionConfigured } from "@/lib/built-in-api-service/encryption";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SERVICE_CATALOG_SETTING_KEY_PREFIX = "service_catalog_";

const summarizeRawCatalogPayload = (raw: string | null) => {
  if (!raw) {
    return {
      hasSetting: false,
      parseOk: false,
      subtasks: {},
    };
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const subtasksRaw =
      parsed && typeof parsed === "object" && parsed.subtasks && typeof parsed.subtasks === "object"
        ? (parsed.subtasks as Record<string, unknown>)
        : { default: parsed };
    const subtasks: Record<string, unknown> = {};
    for (const [subtaskId, value] of Object.entries(subtasksRaw)) {
      const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      const apiKeyPayload = typeof record.apiKey === "string" ? record.apiKey : "";
      subtasks[subtaskId] = {
        hasBaseUrlPayload: typeof record.baseUrl === "string" && record.baseUrl.trim().length > 0,
        hasApiKeyPayload: apiKeyPayload.length > 0,
        apiKeyPayloadLen: apiKeyPayload.length,
        apiKeyLooksEncrypted: apiKeyPayload.startsWith("v1::"),
        enabledPayload: record.isEnabled,
        modelPayload: typeof record.model === "string" ? record.model : "",
      };
    }
    return {
      hasSetting: true,
      parseOk: true,
      defaultSubtaskId:
        typeof parsed.defaultSubtaskId === "string" ? parsed.defaultSubtaskId : undefined,
      subtasks,
    };
  } catch (error) {
    return {
      hasSetting: true,
      parseOk: false,
      parseError: error instanceof Error ? error.message : String(error),
      subtasks: {},
    };
  }
};

export async function GET() {
  const unauthorized = await requireAdminSession();
  if (unauthorized) return unauthorized;

  try {
    await initializeSystemSettingsTable();
    const settings = await getBuiltInRuntimeSettings();
    const rawRows = await sql<{ setting_key: string; setting_value: string }>`
      SELECT setting_key, setting_value
      FROM built_in_system_settings
      WHERE setting_key LIKE 'service_catalog_%'
    `;
    const rawByKey = new Map(rawRows.rows.map((row) => [row.setting_key, row.setting_value]));

    const categories: Record<string, unknown> = {};
    for (const category of BUILT_IN_SERVICE_CATEGORIES) {
      const catalogCategory = settings.serviceCatalog[category];
      const decryptedSubtasks: Record<string, unknown> = {};
      for (const [subtaskId, subtask] of Object.entries(catalogCategory.subtasks)) {
        decryptedSubtasks[subtaskId] = {
          hasBaseUrl: subtask.baseUrl.trim().length > 0,
          hasApiKey: subtask.apiKey.trim().length > 0,
          apiKeyLen: subtask.apiKey.length,
          isEnabled: subtask.isEnabled !== false,
          model: subtask.model || "",
        };
      }

      const rawKey = `${SERVICE_CATALOG_SETTING_KEY_PREFIX}${category}`;
      categories[category] = {
        defaultSubtaskId: catalogCategory.defaultSubtaskId,
        decryptedSubtasks,
        raw: summarizeRawCatalogPayload(rawByKey.get(rawKey) || null),
      };
    }

    return NextResponse.json(
      {
        encryption: {
          configured: isEncryptionConfigured(),
        },
        categories,
      },
      { headers: noStoreHeaders() }
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to inspect catalog",
      },
      { status: 500, headers: noStoreHeaders() }
    );
  }
}
