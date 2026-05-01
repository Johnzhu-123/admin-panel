import { NextResponse } from "next/server";

export const runtime = "nodejs";

type TestPayload = {
  url?: string;
  urls?: string[] | string;
};

type ProbeResult = {
  url: string;
  ok: boolean;
  severity: "ok" | "warn" | "error";
  status?: number;
  message: string;
  detail?: string;
};

const normalizeUrl = (value?: string) => (value || "").trim().replace(/\/+$/, "");

const isValidIopaintUrl = (value: string) => {
  const normalized = normalizeUrl(value);
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    if (!/^https?:$/i.test(parsed.protocol)) return false;
    const host = (parsed.hostname || "").toLowerCase();
    if (!host) return false;
    const isLocalhost = host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0";
    const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
    const isDomainLike = host.includes(".");
    return isLocalhost || isIpv4 || isDomainLike;
  } catch {
    return false;
  }
};

const parseUrls = (raw: unknown) => {
  if (Array.isArray(raw)) {
    return Array.from(
      new Set(
        raw
          .map((item) => normalizeUrl(String(item || "")))
          .filter((item) => isValidIopaintUrl(item))
      )
    );
  }
  if (typeof raw === "string") {
    return Array.from(
      new Set(
        raw
          .split(/[\n,;]/)
          .map((item) => normalizeUrl(item))
          .filter((item) => isValidIopaintUrl(item))
      )
    );
  }
  return [] as string[];
};

const toServerConfigUrl = (inpaintUrl: string) => {
  try {
    const parsed = new URL(inpaintUrl);
    parsed.pathname = "/api/v1/server-config";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return inpaintUrl;
  }
};

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Y8+8AAAAASUVORK5CYII=";

const buildProbeJson = () => ({
  image: TINY_PNG_BASE64,
  mask: TINY_PNG_BASE64,
});

const probeOne = async (url: string): Promise<ProbeResult> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);

  try {
    const serverConfigUrl = toServerConfigUrl(url);
    let serverConfigReachable = false;

    try {
      const cfgResp = await fetch(serverConfigUrl, {
        method: "GET",
        signal: controller.signal,
      });
      serverConfigReachable = cfgResp.status >= 200 && cfgResp.status < 400;
    } catch {
      // Ignore and continue probing /inpaint.
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildProbeJson()),
      signal: controller.signal,
    });

    const status = response.status;
    const detail = (await response.text().catch(() => "")).slice(0, 240);

    if (status === 200) {
      return {
        url,
        ok: true,
        severity: "ok",
        status,
        message: "连接成功，IOPaint 可用。",
        detail,
      };
    }

    if (status === 404) {
      return {
        url,
        ok: false,
        severity: "error",
        status,
        message: "连接成功但接口路径不存在（404），请确认地址是否为 /api/v1/inpaint。",
        detail,
      };
    }

    if (status >= 500) {
      return {
        url,
        ok: serverConfigReachable,
        severity: serverConfigReachable ? "warn" : "error",
        status,
        message: serverConfigReachable
          ? "服务可达，但探针请求返回 5xx（通常是模型加载或参数限制导致）。"
          : `服务返回异常状态码 HTTP ${status}。`,
        detail,
      };
    }

    if (status >= 400) {
      return {
        url,
        ok: serverConfigReachable,
        severity: serverConfigReachable ? "warn" : "error",
        status,
        message: serverConfigReachable
          ? `服务可达，但返回 HTTP ${status}（可能是版本差异或参数要求不同）。`
          : `服务返回异常状态码 HTTP ${status}。`,
        detail,
      };
    }

    return {
      url,
      ok: true,
      severity: "ok",
      status,
      message: "连接成功。",
      detail,
    };
  } catch (error: any) {
    const message = (error?.message || "").toString() || "请求失败。";
    return {
      url,
      ok: false,
      severity: "error",
      message: `无法连接 IOPaint 服务：${message}`,
    };
  } finally {
    clearTimeout(timeout);
  }
};

export async function POST(request: Request) {
  if (process.env.ELECTRON_DESKTOP === "1") {
    return NextResponse.json(
      { ok: false, error: "IOPaint 检测是管理后台接口，请在 Web 管理面板中使用。" },
      { status: 403 }
    );
  }

  let payload: TestPayload = {};
  try {
    payload = await request.json();
  } catch {
    // Ignore invalid JSON body and continue with defaults.
  }

  const normalizedSingle = normalizeUrl(payload.url || "");
  const parsed = parseUrls(payload.urls);
  const targets = parsed.length
    ? parsed
    : normalizedSingle && isValidIopaintUrl(normalizedSingle)
      ? [normalizedSingle]
      : [];

  if (!targets.length) {
    return NextResponse.json(
      { ok: false, error: "请先填写至少一个有效的 IOPaint 地址。" },
      { status: 400 }
    );
  }

  const results = await Promise.all(targets.map((url) => probeOne(url)));
  const okCount = results.filter((item) => item.severity === "ok").length;
  const warnCount = results.filter((item) => item.severity === "warn").length;
  const errorCount = results.filter((item) => item.severity === "error").length;
  const summaryMessage = `检测完成：可用 ${okCount}，告警 ${warnCount}，失败 ${errorCount}。`;

  if (targets.length === 1) {
    const item = results[0];
    if (!item.ok && item.severity === "error") {
      return NextResponse.json(
        {
          ok: false,
          severity: item.severity,
          status: item.status,
          error: item.message,
          detail: item.detail,
          url: item.url,
        },
        { status: 200 }
      );
    }
    return NextResponse.json({
      ok: item.ok,
      severity: item.severity,
      status: item.status,
      message: item.message,
      detail: item.detail,
      url: item.url,
    });
  }

  return NextResponse.json({
    ok: errorCount === 0,
    severity:
      errorCount > 0 ? (okCount > 0 || warnCount > 0 ? "warn" : "error") : warnCount > 0 ? "warn" : "ok",
    message: summaryMessage,
    summary: {
      total: results.length,
      ok: okCount,
      warn: warnCount,
      error: errorCount,
    },
    results,
  });
}
