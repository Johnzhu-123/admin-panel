import { NextRequest, NextResponse } from "next/server";
import {
  fetchPublicHttpUrl,
  resolvePublicHttpTarget,
} from "@/lib/network/public-url";
import { requestPinnedHttpTarget } from "@/lib/network/pinned-http";

// 🔧 NEW (2026-07-03 R3 自动更新链路): 桌面端 electron-updater 的 generic feed 代理。
//
// 背景：桌面仓 github.com/Johnzhu-123/md2pptWin 是私有仓，electron-updater 的
// github provider 无法在分发版里携带 token；因此桌面 publish 采用 generic provider，
// feed 指向本路由，由服务端持有 GITHUB_RELEASES_TOKEN 代理 GitHub Releases 资产。
//
// 链路：
//   桌面 UPDATE_URL（默认 https://ppt2admin.onrender.com/api/desktop-update）
//     → GET /api/desktop-update/latest.yml        （电子更新元数据）
//     → GET /api/desktop-update/<installer.exe>   （安装包 / blockmap）
//   本路由 → GitHub API releases/latest → 按文件名匹配资产 → 302 无法带鉴权，
//   故服务端 fetch asset（Accept: application/octet-stream）后流式转发。
//
// 发布方式（打包机执行）：
//   npm run electron:build:win && gh release create v<version> \
//     dist/*.exe dist/*.blockmap dist/latest.yml
//
// 环境变量（Render Dashboard 配置）：
//   GITHUB_RELEASES_TOKEN — 具 repo read 权限的 fine-grained PAT / classic token
//   DESKTOP_RELEASES_REPO — 缺省 "Johnzhu-123/md2pptWin"
//
// 未配置 token 时返回 503（桌面「检查更新」显示更新服务未就绪，不影响其它功能）。

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RELEASES_REPO = () =>
  (process.env.DESKTOP_RELEASES_REPO || "Johnzhu-123/md2pptWin").trim();

const GITHUB_API = "https://api.github.com";
const MAX_DOWNLOAD_REDIRECTS = 3;

class DesktopUpdateUpstreamError extends Error {
  constructor(
    message: string,
    public readonly status: 502 | 503 | 504,
    public readonly retryAfter?: string
  ) {
    super(message);
    this.name = "DesktopUpdateUpstreamError";
  }
}

const normalizeReleasesRepo = () => {
  const repo = RELEASES_REPO();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("DESKTOP_RELEASES_REPO must use owner/repository format");
  }
  return repo;
};

const isAllowedGitHubAssetApiUrl = (value: string, repo: string) => {
  try {
    const url = new URL(value);
    const [owner, repository] = repo.split("/");
    const segments = url.pathname.split("/").filter(Boolean);
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "api.github.com" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search &&
      segments.length === 6 &&
      segments[0]?.toLowerCase() === "repos" &&
      segments[1]?.toLowerCase() === owner?.toLowerCase() &&
      segments[2]?.toLowerCase() === repository?.toLowerCase() &&
      segments[3]?.toLowerCase() === "releases" &&
      segments[4]?.toLowerCase() === "assets" &&
      /^\d+$/.test(segments[5] || "")
    );
  } catch {
    return false;
  }
};

const GITHUB_RELEASE_CDN_HOSTS = new Set([
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);

const isAllowedGitHubDownloadUrl = (url: URL, repo: string) => {
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash
  ) {
    return false;
  }
  const hostname = url.hostname.toLowerCase();
  if (GITHUB_RELEASE_CDN_HOSTS.has(hostname)) {
    return url.pathname.startsWith("/");
  }
  if (hostname !== "github.com") return false;
  const expectedPrefix = `/${repo}/releases/download/`.toLowerCase();
  return url.pathname.toLowerCase().startsWith(expectedPrefix);
};

const networkErrorStatus = (error: unknown): 502 | 504 => {
  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name || "")
      : "";
  return name === "AbortError" || name === "TimeoutError" ? 504 : 502;
};

const upstreamErrorResponse = (error: unknown) => {
  const mapped =
    error instanceof DesktopUpdateUpstreamError
      ? error
      : new DesktopUpdateUpstreamError(
          networkErrorStatus(error) === 504
            ? "desktop update upstream timed out"
            : "desktop update upstream unavailable",
          networkErrorStatus(error)
        );
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (mapped.retryAfter) headers.set("Retry-After", mapped.retryAfter);
  return NextResponse.json({ error: mapped.message }, { status: mapped.status, headers });
};

// latest release 元数据 60s 进程内缓存：省 API 配额，也让 latest.yml 拉取更快。
// serverless 冷启自动失效，无一致性风险（更新检查本就允许分钟级滞后）。
let latestCache: { at: number; data: ReleaseInfo } | null = null;
const LATEST_CACHE_TTL_MS = 60_000;

interface ReleaseAsset {
  name: string;
  url: string; // API asset url（配 octet-stream Accept 下载）
  size: number;
  content_type: string;
}
interface ReleaseInfo {
  tag_name: string;
  assets: ReleaseAsset[];
}

const githubHeaders = (token: string, accept: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: accept,
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "md2ppt-admin-panel-desktop-update",
});

async function fetchLatestRelease(token: string, repo: string): Promise<ReleaseInfo | null> {
  if (
    process.env.NODE_ENV !== "test" &&
    latestCache &&
    Date.now() - latestCache.at < LATEST_CACHE_TTL_MS
  ) {
    return latestCache.data;
  }
  const res = await fetchPublicHttpUrl(
    `${GITHUB_API}/repos/${repo}/releases/latest`,
    { headers: githubHeaders(token, "application/vnd.github+json"), cache: "no-store" },
    {
      description: "GitHub release metadata",
      allowHttp: false,
      allowPrivateNetwork: false,
      maxRedirects: 0,
    }
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const retryAfter = res.headers.get("retry-after") || undefined;
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      throw new DesktopUpdateUpstreamError(
        "desktop update service is not ready",
        503,
        retryAfter
      );
    }
    throw new DesktopUpdateUpstreamError("GitHub release metadata unavailable", 502);
  }
  let data: ReleaseInfo;
  try {
    data = (await res.json()) as ReleaseInfo;
  } catch {
    throw new DesktopUpdateUpstreamError("GitHub release metadata was invalid", 502);
  }
  if (
    !data ||
    typeof data.tag_name !== "string" ||
    !data.tag_name.trim() ||
    !Array.isArray(data.assets) ||
    data.assets.some(
      (asset) =>
        !asset ||
        typeof asset.name !== "string" ||
        typeof asset.url !== "string" ||
        !Number.isSafeInteger(asset.size) ||
        asset.size < 0
    )
  ) {
    throw new DesktopUpdateUpstreamError("GitHub release metadata was invalid", 502);
  }
  if (process.env.NODE_ENV !== "test") {
    latestCache = { at: Date.now(), data };
  }
  return data;
}

async function fetchAllowedGitHubDownload(startUrl: URL, repo: string) {
  let current = startUrl;
  for (let redirects = 0; redirects <= MAX_DOWNLOAD_REDIRECTS; redirects += 1) {
    if (!isAllowedGitHubDownloadUrl(current, repo)) {
      throw new DesktopUpdateUpstreamError(
        "GitHub asset redirect target was rejected",
        502
      );
    }
    const target = await resolvePublicHttpTarget(current, {
      description: "GitHub release asset download",
      allowHttp: false,
      allowPrivateNetwork: false,
    });
    const response = await requestPinnedHttpTarget(target, {
      headers: {
        Accept: "application/octet-stream",
        "User-Agent": "md2ppt-admin-panel-desktop-update",
      },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
    });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location || redirects >= MAX_DOWNLOAD_REDIRECTS) {
      throw new DesktopUpdateUpstreamError(
        location
          ? "GitHub asset redirect limit exceeded"
          : "GitHub asset redirect was invalid",
        502
      );
    }
    current = new URL(location, target.url);
  }
  throw new DesktopUpdateUpstreamError("GitHub asset redirect limit exceeded", 502);
}

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  ".yml": "text/yaml; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".exe": "application/octet-stream",
  ".blockmap": "application/octet-stream",
  ".zip": "application/zip",
};

function contentTypeFor(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  return CONTENT_TYPE_BY_EXT[ext] || "application/octet-stream";
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> }
) {
  const token = (process.env.GITHUB_RELEASES_TOKEN || "").trim();
  if (!token) {
    return NextResponse.json(
      {
        error: "desktop update service not configured",
        hint: "set GITHUB_RELEASES_TOKEN in the deployment environment",
      },
      { status: 503 }
    );
  }

  const { path } = await params;
  const fileName = decodeURIComponent((path || []).join("/")).trim();
  if (!fileName || fileName.includes("..")) {
    return NextResponse.json({ error: "asset name required" }, { status: 400 });
  }

  let repo: string;
  try {
    repo = normalizeReleasesRepo();
  } catch {
    return NextResponse.json(
      { error: "desktop update repository configuration is invalid" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }

  let release: ReleaseInfo | null;
  try {
    release = await fetchLatestRelease(token, repo);
  } catch (error) {
    return upstreamErrorResponse(error);
  }
  if (!release) {
    return NextResponse.json(
      { error: "no published release available" },
      { status: 404 }
    );
  }

  const asset = release.assets.find((a) => a.name === fileName);
  if (!asset) {
    return NextResponse.json(
      { error: `asset "${fileName}" not found in release ${release.tag_name}` },
      { status: 404 }
    );
  }

  if (!isAllowedGitHubAssetApiUrl(asset.url, repo)) {
    return NextResponse.json(
      { error: "release asset URL is outside the configured GitHub repository" },
      { status: 502 }
    );
  }

  let upstream: Response;
  try {
    const assetTarget = await resolvePublicHttpTarget(asset.url, {
      description: "GitHub release asset API",
      allowHttp: false,
      allowPrivateNetwork: false,
    });
    upstream = await requestPinnedHttpTarget(assetTarget, {
      headers: githubHeaders(token, "application/octet-stream"),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get("location");
      await upstream.body?.cancel().catch(() => undefined);
      if (!location) {
        throw new DesktopUpdateUpstreamError("GitHub asset redirect was invalid", 502);
      }
      upstream = await fetchAllowedGitHubDownload(
        new URL(location, assetTarget.url),
        repo
      );
    }
  } catch (error) {
    return upstreamErrorResponse(error);
  }
  if (!upstream.ok || !upstream.body) {
    await upstream.body?.cancel().catch(() => undefined);
    return NextResponse.json(
      { error: `failed to fetch asset (HTTP ${upstream.status})` },
      { status: 502 }
    );
  }

  const headers = new Headers({
    "Content-Type": contentTypeFor(asset.name),
    "Cache-Control": "no-store",
    "X-Release-Tag": release.tag_name,
  });
  if (asset.size > 0) headers.set("Content-Length", String(asset.size));
  return new NextResponse(upstream.body, { status: 200, headers });
}
