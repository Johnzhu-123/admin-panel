import { NextRequest, NextResponse } from "next/server";

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

async function fetchLatestRelease(token: string): Promise<ReleaseInfo | null> {
  if (latestCache && Date.now() - latestCache.at < LATEST_CACHE_TTL_MS) {
    return latestCache.data;
  }
  const res = await fetch(
    `${GITHUB_API}/repos/${RELEASES_REPO()}/releases/latest`,
    { headers: githubHeaders(token, "application/vnd.github+json"), cache: "no-store" }
  );
  if (!res.ok) return null;
  const data = (await res.json()) as ReleaseInfo;
  if (!data || !Array.isArray(data.assets)) return null;
  latestCache = { at: Date.now(), data };
  return data;
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

  let release: ReleaseInfo | null;
  try {
    release = await fetchLatestRelease(token);
  } catch {
    release = null;
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

  const upstream = await fetch(asset.url, {
    headers: githubHeaders(token, "application/octet-stream"),
    cache: "no-store",
    redirect: "follow",
  });
  if (!upstream.ok || !upstream.body) {
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
