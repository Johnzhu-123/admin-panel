/**
 * Admin-panel proxy URL helpers.
 *
 * Keep this separate from upstream AI base URLs:
 * - proxy/admin-panel URL: receives control-plane requests such as auth/config.
 * - upstream AI base URL: receives model calls such as /v1/chat/completions.
 */

export const BUILT_IN_PROXY_HEADER = "x-built-in-service-server-url";
export const BUILT_IN_PROXY_URL_STORAGE_KEY =
  "md2ppt.builtInServiceServerUrl.v1";
export const DEFAULT_BUILT_IN_PROXY_URL = "https://ppt2admin.onrender.com";
export const LEGACY_BUILT_IN_PROXY_URL = "https://ppt2admin.zeabur.app";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export const normalizeBuiltInProxyUrl = (value?: string | null) => {
  const trimmed = (value || "").trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : "";
};

export const isTruthyEnv = (value?: string | null) =>
  TRUE_VALUES.has((value || "").trim().toLowerCase());

export function looksLikeUpstreamAiBaseUrl(value?: string | null): boolean {
  const normalized = normalizeBuiltInProxyUrl(value);
  if (!normalized) return false;
  try {
    const url = new URL(normalized);
    const hostname = url.hostname.toLowerCase();
    const pathname = url.pathname.replace(/\/+$/, "").toLowerCase();
    if (hostname === "api.seeyjys.eu.org") return true;
    if (hostname === "api.openai.com") return true;
    if (/(^|\.)generativelanguage\.googleapis\.com$/i.test(hostname)) {
      return true;
    }
    return /^\/v\d+(?:alpha|beta)?$/i.test(pathname);
  } catch {
    return false;
  }
}

const getEnv = (): Record<string, string | undefined> =>
  typeof process !== "undefined" && process.env ? process.env : {};

export function getConfiguredBuiltInProxyBase(): string {
  const env = getEnv();
  const explicit = normalizeBuiltInProxyUrl(
    env.BUILT_IN_PROXY_SERVER_URL ||
      env.NEXT_PUBLIC_BUILT_IN_PROXY_SERVER_URL ||
      ""
  );
  if (explicit) return explicit;

  const legacy = normalizeBuiltInProxyUrl(
    env.BUILT_IN_SERVICE_SERVER_URL ||
      env.NEXT_PUBLIC_BUILT_IN_SERVICE_SERVER_URL ||
      ""
  );
  if (!legacy || looksLikeUpstreamAiBaseUrl(legacy)) return "";
  return legacy;
}

export function getBuiltInProxyBaseFromRequest(req: Request): string {
  const fromHeader = normalizeBuiltInProxyUrl(
    req.headers.get(BUILT_IN_PROXY_HEADER) || ""
  );
  const isDesktop = getEnv().ELECTRON_DESKTOP === "1";
  if (fromHeader && isDesktop && !looksLikeUpstreamAiBaseUrl(fromHeader)) {
    return fromHeader;
  }
  if (!isDesktop) return "";
  return getConfiguredBuiltInProxyBase();
}
