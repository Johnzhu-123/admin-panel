import {
  getSystemSetting,
  initializeSystemSettingsTable,
  setSystemSetting,
} from "./db";
import { decryptSecret, encryptSecret, maskSecret } from "./encryption";

export type MinerUExtraFormat = "docx" | "html" | "latex";

export interface MinerURuntimeDefaultOptions {
  modelVersion: "vlm" | "pipeline" | "MinerU-HTML" | "auto";
  language: string;
  enableFormula: boolean;
  enableTable: boolean;
  isOcr: boolean;
  extraFormats: MinerUExtraFormat[];
}

export interface MinerURuntimeSettings {
  enabled: boolean;
  baseUrl: string;
  apiToken: string;
  defaultOptions: MinerURuntimeDefaultOptions;
}

export interface SanitizedMinerURuntimeSettings
  extends Omit<MinerURuntimeSettings, "apiToken"> {
  apiToken?: never;
  apiTokenConfigured: boolean;
  apiTokenMask: string;
}

const SETTING_KEY = "mineru_runtime_settings";
const EXTRA_FORMATS: MinerUExtraFormat[] = ["docx", "html", "latex"];
const MODEL_VERSIONS = new Set(["vlm", "pipeline", "MinerU-HTML", "auto"]);

export const DEFAULT_MINERU_RUNTIME_SETTINGS: MinerURuntimeSettings = {
  enabled: true,
  baseUrl: "https://mineru.net",
  apiToken: "",
  defaultOptions: {
    modelVersion: "vlm",
    language: "ch",
    enableFormula: true,
    enableTable: true,
    isOcr: false,
    extraFormats: [],
  },
};

const normalizeUrl = (value?: string | null) => (value || "").trim().replace(/\/+$/, "");

const envBool = (key: string, fallback: boolean): boolean => {
  const v = (process.env[key] || "").trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(v)) return true;
  if (["false", "0", "no", "off"].includes(v)) return false;
  return fallback;
};

const envString = (key: string, fallback: string): string => {
  const v = (process.env[key] || "").trim();
  return v || fallback;
};

const parseExtraFormats = (raw: unknown): MinerUExtraFormat[] => {
  const input = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(",")
      : [];
  const seen = new Set<string>();
  const out: MinerUExtraFormat[] = [];
  for (const item of input) {
    const value = String(item || "").trim() as MinerUExtraFormat;
    if (!EXTRA_FORMATS.includes(value) || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
};

const isMaskedSecret = (value: string): boolean => {
  if (!value) return false;
  return /\*{4,}/.test(value) || /^\*+$/.test(value);
};

export function getMinerURuntimeSettingsFromEnv(): MinerURuntimeSettings {
  return {
    enabled: envBool("MINERU_BUILT_IN_ENABLED", true),
    baseUrl: normalizeUrl(envString("MINERU_BUILT_IN_BASE_URL", "https://mineru.net")),
    apiToken: (process.env.MINERU_BUILT_IN_API_TOKEN || "").trim(),
    defaultOptions: {
      modelVersion: MODEL_VERSIONS.has(envString("MINERU_DEFAULT_MODEL_VERSION", "vlm"))
        ? (envString("MINERU_DEFAULT_MODEL_VERSION", "vlm") as MinerURuntimeDefaultOptions["modelVersion"])
        : "vlm",
      language: envString("MINERU_DEFAULT_LANGUAGE", "ch"),
      enableFormula: envBool("MINERU_DEFAULT_ENABLE_FORMULA", true),
      enableTable: envBool("MINERU_DEFAULT_ENABLE_TABLE", true),
      isOcr: envBool("MINERU_DEFAULT_IS_OCR", false),
      extraFormats: parseExtraFormats(process.env.MINERU_DEFAULT_EXTRA_FORMATS || ""),
    },
  };
}

export function mergeMinerURuntimeSettings(
  current: MinerURuntimeSettings,
  patch: Partial<MinerURuntimeSettings>
): MinerURuntimeSettings {
  const patchOptions = (patch.defaultOptions || {}) as Partial<MinerURuntimeDefaultOptions>;
  const incomingModel = String(patchOptions.modelVersion || "").trim();
  const modelVersion = MODEL_VERSIONS.has(incomingModel)
    ? (incomingModel as MinerURuntimeDefaultOptions["modelVersion"])
    : current.defaultOptions.modelVersion;
  const incomingBaseUrl =
    typeof patch.baseUrl === "string" ? normalizeUrl(patch.baseUrl) : current.baseUrl;
  const apiToken =
    typeof patch.apiToken === "string" && !isMaskedSecret(patch.apiToken)
      ? patch.apiToken.trim()
      : current.apiToken;

  return {
    enabled:
      typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
    baseUrl: /^https?:\/\//i.test(incomingBaseUrl)
      ? incomingBaseUrl
      : current.baseUrl || DEFAULT_MINERU_RUNTIME_SETTINGS.baseUrl,
    apiToken,
    defaultOptions: {
      modelVersion,
      language:
        typeof patchOptions.language === "string" && patchOptions.language.trim()
          ? patchOptions.language.trim()
          : current.defaultOptions.language,
      enableFormula:
        typeof patchOptions.enableFormula === "boolean"
          ? patchOptions.enableFormula
          : current.defaultOptions.enableFormula,
      enableTable:
        typeof patchOptions.enableTable === "boolean"
          ? patchOptions.enableTable
          : current.defaultOptions.enableTable,
      isOcr:
        typeof patchOptions.isOcr === "boolean"
          ? patchOptions.isOcr
          : current.defaultOptions.isOcr,
      extraFormats:
        patchOptions.extraFormats !== undefined
          ? parseExtraFormats(patchOptions.extraFormats)
          : current.defaultOptions.extraFormats,
    },
  };
}

export function sanitizeMinerURuntimeSettings(
  settings: MinerURuntimeSettings
): SanitizedMinerURuntimeSettings {
  return {
    enabled: settings.enabled,
    baseUrl: settings.baseUrl,
    defaultOptions: settings.defaultOptions,
    apiTokenConfigured: Boolean(settings.apiToken),
    apiTokenMask: settings.apiToken ? maskSecret(settings.apiToken) : "",
  };
}

export async function getMinerURuntimeSettings(): Promise<MinerURuntimeSettings> {
  const envSettings = getMinerURuntimeSettingsFromEnv();
  try {
    await initializeSystemSettingsTable();
    const raw = await getSystemSetting(SETTING_KEY);
    if (!raw) return envSettings;
    const parsed = JSON.parse(raw) as Partial<MinerURuntimeSettings>;
    const encryptedToken =
      typeof parsed.apiToken === "string" ? parsed.apiToken : undefined;
    return mergeMinerURuntimeSettings(envSettings, {
      ...parsed,
      apiToken:
        encryptedToken === undefined ? undefined : decryptSecret(encryptedToken),
    });
  } catch (error) {
    console.error("[mineru-settings] Failed to load MinerU settings:", error);
    return envSettings;
  }
}

export async function saveMinerURuntimeSettings(
  patch: Partial<MinerURuntimeSettings>
): Promise<MinerURuntimeSettings> {
  await initializeSystemSettingsTable();
  const current = await getMinerURuntimeSettings();
  const merged = mergeMinerURuntimeSettings(current, patch);
  await setSystemSetting(
    SETTING_KEY,
    JSON.stringify({
      ...merged,
      apiToken: merged.apiToken ? encryptSecret(merged.apiToken) : "",
      updatedAt: new Date().toISOString(),
    })
  );
  return merged;
}
