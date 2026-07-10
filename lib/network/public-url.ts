import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  requestPinnedHttpTarget,
  type PinnedAddress,
  type ResolvedHttpTarget,
} from "@/lib/network/pinned-http";

type PublicHttpUrlOptions = {
  allowHttp?: boolean;
  allowPrivateNetwork?: boolean;
  description?: string;
};

type FetchPublicHttpUrlOptions = PublicHttpUrlOptions & {
  maxRedirects?: number;
  dnsTimeoutMs?: number;
  lookupFn?: typeof lookup;
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const EXPLICITLY_BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.google.internal.",
  "metadata.aliyun.internal",
  "instance-data",
]);

/**
 * 🔧 FIX (2026-06-11 BUG-B11/AS6): 私网封禁误杀桌面场景的统一判定。
 *
 * 背景：Electron 桌面端本就运行在用户本机，代理 127.0.0.1 / 192.168.x 的自建模型
 * （IndexTTS、LM Studio、本地视频服务等）是合法刚需；但 SSRF 防护默认拒绝私网，
 * 且 MD2PPT_ALLOW_PRIVATE_API_PROXY 没有任何设置入口，桌面用户被一刀切误杀。
 *
 * 语义（显式 env 优先）：
 * - MD2PPT_ALLOW_PRIVATE_API_PROXY 显式设置时以它为准（兼容 '1'/'true'/'yes'/'on'，
 *   显式 '0'/'false' 即使在桌面端也维持封禁）；
 * - 未显式设置时，ELECTRON_DESKTOP === '1'（桌面运行时标记）默认放行私网；
 * - Web/服务器部署两者皆无 → 维持封禁（SSRF 防护不变）。
 */
export const shouldAllowPrivateNetworkAccess = (): boolean => {
  const explicit = String(
    process.env.MD2PPT_ALLOW_PRIVATE_API_PROXY || ""
  ).trim();
  if (explicit) {
    return /^(1|true|yes|on)$/i.test(explicit);
  }
  return process.env.ELECTRON_DESKTOP === "1";
};

const IPV4_BLOCKED_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/4",
  "240.0.0.0/4",
];

const IPV6_BLOCKED_CIDRS = [
  "::/128",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
];

const IPV6_MAPPED_V4_CIDR = parseCidr("::ffff:0:0/96");

function normalizeHostname(hostname: string) {
  return hostname.trim().replace(/\.$/, "").toLowerCase();
}

function parseIpv4ToBigInt(address: string) {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return null;
  }

  let result = 0n;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      return null;
    }
    result = (result << 8n) + BigInt(value);
  }
  return result;
}

function expandIpv6(address: string) {
  let normalized = address.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  normalized = normalized.split("%")[0] || normalized;
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    if (lastColon === -1) {
      return null;
    }
    const ipv4Part = normalized.slice(lastColon + 1);
    const ipv4Value = parseIpv4ToBigInt(ipv4Part);
    if (ipv4Value === null) {
      return null;
    }
    const high = Number((ipv4Value >> 16n) & 0xffffn).toString(16);
    const low = Number(ipv4Value & 0xffffn).toString(16);
    normalized = `${normalized.slice(0, lastColon)}:${high}:${low}`;
  }

  const hasCompression = normalized.includes("::");
  if (hasCompression && normalized.indexOf("::") !== normalized.lastIndexOf("::")) {
    return null;
  }

  const [headRaw, tailRaw] = normalized.split("::");
  const head = headRaw ? headRaw.split(":").filter(Boolean) : [];
  const tail = tailRaw ? tailRaw.split(":").filter(Boolean) : [];

  const missing = hasCompression ? 8 - (head.length + tail.length) : 0;
  if (missing < 0) {
    return null;
  }

  const groups = hasCompression
    ? [...head, ...Array(missing).fill("0"), ...tail]
    : head;

  if (groups.length !== 8) {
    return null;
  }

  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) {
      return null;
    }
  }

  return groups;
}

function parseIpv6ToBigInt(address: string) {
  const groups = expandIpv6(address);
  if (!groups) {
    return null;
  }

  return groups.reduce((acc, part) => (acc << 16n) + BigInt(parseInt(part, 16)), 0n);
}

function parseCidr(cidr: string) {
  const [rawAddress, prefixText] = cidr.split("/");
  const version = isIP(rawAddress);
  if (version !== 4 && version !== 6) {
    throw new Error(`Unsupported CIDR address: ${cidr}`);
  }

  const bits = version === 4 ? 32 : 128;
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) {
    throw new Error(`Invalid CIDR prefix: ${cidr}`);
  }

  const address =
    version === 4 ? parseIpv4ToBigInt(rawAddress) : parseIpv6ToBigInt(rawAddress);
  if (address === null) {
    throw new Error(`Invalid CIDR address: ${cidr}`);
  }

  return { address, prefix, bits };
}

const parsedIpv4Cidrs = IPV4_BLOCKED_CIDRS.map(parseCidr);
const parsedIpv6Cidrs = IPV6_BLOCKED_CIDRS.map(parseCidr);

function isIpInCidr(ip: bigint, cidr: { address: bigint; prefix: number; bits: number }) {
  const hostBits = BigInt(cidr.bits - cidr.prefix);
  if (hostBits === 0n) {
    return ip === cidr.address;
  }
  return (ip >> hostBits) === (cidr.address >> hostBits);
}

function isBlockedIpv4(address: string) {
  const ip = parseIpv4ToBigInt(address);
  if (ip === null) {
    return false;
  }
  return parsedIpv4Cidrs.some((cidr) => isIpInCidr(ip, cidr));
}

function isBlockedIpv6(address: string) {
  const ip = parseIpv6ToBigInt(address);
  if (ip === null) {
    return false;
  }

  if (isIpInCidr(ip, IPV6_MAPPED_V4_CIDR)) {
    const mappedIpv4 = [
      Number((ip >> 24n) & 0xffn),
      Number((ip >> 16n) & 0xffn),
      Number((ip >> 8n) & 0xffn),
      Number(ip & 0xffn),
    ].join(".");
    return isBlockedIpv4(mappedIpv4);
  }

  return parsedIpv6Cidrs.some((cidr) => isIpInCidr(ip, cidr));
}

function isBlockedIpAddress(address: string) {
  const version = isIP(address);
  if (version === 4) {
    return isBlockedIpv4(address);
  }
  if (version === 6) {
    return isBlockedIpv6(address);
  }
  return false;
}

function isBlockedHostname(hostname: string) {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    return true;
  }
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }
  return EXPLICITLY_BLOCKED_HOSTNAMES.has(normalized);
}

async function resolveHostname(
  hostname: string,
  description: string,
  allowPrivateNetwork: boolean,
  signal?: AbortSignal | null,
  dnsTimeoutMs = 5_000,
  lookupFn: typeof lookup = lookup
): Promise<PinnedAddress[]> {
  const normalized = normalizeHostname(hostname);
  if (!allowPrivateNetwork && isBlockedHostname(normalized)) {
    throw new Error(`${description} 指向受保护的内网或元数据主机。`);
  }
  if (isIP(normalized)) {
    if (!allowPrivateNetwork && isBlockedIpAddress(normalized)) {
      throw new Error(`${description} 指向受保护的内网或本机地址。`);
    }
    return [{ address: normalized, family: isIP(normalized) as 4 | 6 }];
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new DOMException(`${description} DNS 解析超时。`, "TimeoutError")),
      Math.max(1, dnsTimeoutMs)
    );
    if (signal) {
      abortHandler = () => reject(signal.reason || new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  });
  try {
    const records = await Promise.race([
      lookupFn(normalized, { all: true, verbatim: true }),
      timeout,
    ]);
    if (!records.length) throw new Error(`${description} 未解析到可用地址。`);
    const addresses = records.map((record) => ({
      address: record.address,
      family: record.family as 4 | 6,
    }));
    if (
      !allowPrivateNetwork &&
      addresses.some((record) => isBlockedIpAddress(record.address))
    ) {
      throw new Error(`${description} 解析到了内网、回环或保留地址。`);
    }
    return addresses;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
  }
}

export async function resolvePublicHttpTarget(
  value: string | URL,
  options: FetchPublicHttpUrlOptions = {},
  signal?: AbortSignal | null,
  lookupFn: typeof lookup = lookup
): Promise<ResolvedHttpTarget> {
  const {
    allowHttp = true,
    allowPrivateNetwork = false,
    description = "目标地址",
    dnsTimeoutMs = 5_000,
  } = options;

  let parsedUrl: URL;
  try {
    parsedUrl = value instanceof URL ? new URL(value.toString()) : new URL(value);
  } catch {
    throw new Error(`${description} 不是有效的 URL。`);
  }

  const protocol = parsedUrl.protocol.toLowerCase();
  if (protocol !== "https:" && !(allowHttp && protocol === "http:")) {
    throw new Error(
      allowHttp
        ? `${description} 必须使用 http:// 或 https://。`
        : `${description} 必须使用 https://。`
    );
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw new Error(`${description} 不允许包含账号或密码。`);
  }

  const hostname = normalizeHostname(parsedUrl.hostname);
  if (!hostname) {
    throw new Error(`${description} 缺少主机名。`);
  }

  const addresses = await resolveHostname(
    hostname,
    description,
    allowPrivateNetwork,
    signal,
    dnsTimeoutMs,
    lookupFn
  );
  return { url: parsedUrl, addresses };
}

export async function assertPublicHttpUrl(
  value: string | URL,
  options: PublicHttpUrlOptions = {}
) {
  return (await resolvePublicHttpTarget(value, options)).url;
}

export async function fetchPublicHttpUrl(
  value: string | URL,
  init: RequestInit = {},
  options: FetchPublicHttpUrlOptions = {}
) {
  const method = (init.method || "GET").toUpperCase();
  const maxRedirects = Math.max(0, options.maxRedirects ?? 5);
  let currentValue: string | URL = value;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const target = await resolvePublicHttpTarget(
      currentValue,
      options,
      init.signal,
      options.lookupFn || lookup
    );
    const response = await requestPinnedHttpTarget(target, init);

    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    if (method !== "GET" && method !== "HEAD") {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`${options.description || "目标地址"} 不允许非幂等请求重定向。`);
    }

    const location = response.headers.get("location");
    if (!location) {
      return response;
    }

    if (redirectCount >= maxRedirects) {
      throw new Error(`${options.description || "目标地址"} 重定向次数过多。`);
    }

    await response.body?.cancel().catch(() => undefined);
    currentValue = new URL(location, target.url);
  }

  throw new Error(`${options.description || "目标地址"} 重定向次数过多。`);
}
