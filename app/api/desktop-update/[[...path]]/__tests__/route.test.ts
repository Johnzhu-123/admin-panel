/**
 * @jest-environment node
 *
 * Unit tests for the desktop auto-update proxy route
 * GET /api/desktop-update/[[...path]]
 *
 * 网络出口 (global.fetch) 全部 mock；验证三种关键行为：
 *   1. 未配置 GITHUB_RELEASES_TOKEN → 503（服务未就绪，可诊断）
 *   2. latest.yml 命中 release 资产 → 200 + text/yaml + 流式转发
 *   3. 资产不存在 → 404（附 release tag 便于排障）
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { NextRequest } from 'next/server';
import { fetchPublicHttpUrl, resolvePublicHttpTarget } from '@/lib/network/public-url';
import { requestPinnedHttpTarget } from '@/lib/network/pinned-http';
import { GET } from '../route';

jest.mock('@/lib/network/public-url', () => ({
  fetchPublicHttpUrl: jest.fn(),
  resolvePublicHttpTarget: jest.fn(),
}));
jest.mock('@/lib/network/pinned-http', () => ({
  requestPinnedHttpTarget: jest.fn(),
}));

const mockedFetchPublic = fetchPublicHttpUrl as jest.MockedFunction<
  typeof fetchPublicHttpUrl
>;
const mockedResolve = resolvePublicHttpTarget as jest.MockedFunction<
  typeof resolvePublicHttpTarget
>;
const mockedPinned = requestPinnedHttpTarget as jest.MockedFunction<
  typeof requestPinnedHttpTarget
>;

const makeReq = () =>
  new NextRequest('https://ppt2admin.onrender.com/api/desktop-update/latest.yml');

const makeParams = (segments: string[]) => ({
  params: Promise.resolve({ path: segments }),
});

const RELEASE_FIXTURE = {
  tag_name: 'v1.0.1',
  assets: [
    {
      name: 'latest.yml',
      url: 'https://api.github.com/repos/x/y/releases/assets/1',
      size: 321,
      content_type: 'application/octet-stream',
    },
    {
      name: '星火智绘Pro Setup 1.0.1.exe',
      url: 'https://api.github.com/repos/x/y/releases/assets/2',
      size: 168000000,
      content_type: 'application/octet-stream',
    },
  ],
};

const originalToken = process.env.GITHUB_RELEASES_TOKEN;
const originalRepo = process.env.DESKTOP_RELEASES_REPO;

describe('GET /api/desktop-update/[[...path]]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DESKTOP_RELEASES_REPO = 'x/y';
    mockedResolve.mockResolvedValue({
      url: new URL('https://api.github.com/repos/x/y/releases/assets/1'),
      addresses: [{ address: '140.82.112.6', family: 4 }],
    });
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.GITHUB_RELEASES_TOKEN;
    else process.env.GITHUB_RELEASES_TOKEN = originalToken;
    if (originalRepo === undefined) delete process.env.DESKTOP_RELEASES_REPO;
    else process.env.DESKTOP_RELEASES_REPO = originalRepo;
  });

  it('returns 503 with hint when GITHUB_RELEASES_TOKEN is not configured', async () => {
    delete process.env.GITHUB_RELEASES_TOKEN;
    const res = await GET(makeReq(), makeParams(['latest.yml']));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { hint?: string };
    expect(body.hint).toContain('GITHUB_RELEASES_TOKEN');
  });

  it('proxies latest.yml asset with yaml content-type and release tag header', async () => {
    process.env.GITHUB_RELEASES_TOKEN = 'gh_test_token';
    const yamlBody = 'version: 1.0.1\npath: 星火智绘Pro Setup 1.0.1.exe\n';
    mockedFetchPublic.mockResolvedValueOnce(
      new Response(JSON.stringify(RELEASE_FIXTURE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    mockedPinned.mockResolvedValueOnce(new Response(yamlBody, { status: 200 }));

    const res = await GET(makeReq(), makeParams(['latest.yml']));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/yaml');
    expect(res.headers.get('x-release-tag')).toBe('v1.0.1');
    expect(await res.text()).toBe(yamlBody);
    // 第一跳必须带鉴权访问 GitHub API
    expect(String(mockedFetchPublic.mock.calls[0][0])).toContain('/releases/latest');
    const assetHeaders = new Headers(mockedPinned.mock.calls[0][1]?.headers);
    expect(assetHeaders.get('authorization')).toBe('Bearer gh_test_token');
  });

  it('returns 404 naming the release tag when asset is missing', async () => {
    process.env.GITHUB_RELEASES_TOKEN = 'gh_test_token';
    mockedFetchPublic.mockResolvedValueOnce(
      new Response(JSON.stringify(RELEASE_FIXTURE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const res = await GET(makeReq(), makeParams(['not-exist.exe']));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain('v1.0.1');
  });

  it('rejects asset API URLs outside the configured repository before sending the token', async () => {
    process.env.GITHUB_RELEASES_TOKEN = 'gh_test_token';
    const malicious = {
      ...RELEASE_FIXTURE,
      assets: [
        {
          ...RELEASE_FIXTURE.assets[0],
          url: 'https://attacker.invalid/releases/assets/1',
        },
      ],
    };
    mockedFetchPublic.mockResolvedValueOnce(
      new Response(JSON.stringify(malicious), { status: 200 })
    );

    const res = await GET(makeReq(), makeParams(['latest.yml']));
    expect(res.status).toBe(502);
    expect(mockedResolve).not.toHaveBeenCalled();
    expect(mockedPinned).not.toHaveBeenCalled();
  });

  it('maps metadata network and timeout failures without leaking exception details', async () => {
    process.env.GITHUB_RELEASES_TOKEN = 'gh_test_token';
    mockedFetchPublic.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND secret-host'));
    const unavailable = await GET(makeReq(), makeParams(['latest.yml']));
    expect(unavailable.status).toBe(502);
    expect(await unavailable.json()).toEqual({
      error: 'desktop update upstream unavailable',
    });

    mockedFetchPublic.mockRejectedValueOnce(
      new DOMException('request timed out with internal details', 'TimeoutError')
    );
    const timedOut = await GET(makeReq(), makeParams(['latest.yml']));
    expect(timedOut.status).toBe(504);
    expect(await timedOut.json()).toEqual({
      error: 'desktop update upstream timed out',
    });
  });

  it('maps GitHub authentication failures to service unavailable', async () => {
    process.env.GITHUB_RELEASES_TOKEN = 'gh_test_token';
    mockedFetchPublic.mockResolvedValueOnce(
      new Response('forbidden', { status: 403 })
    );
    const res = await GET(makeReq(), makeParams(['latest.yml']));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'desktop update service is not ready',
    });
  });

  it('rejects invalid repository configuration before contacting GitHub', async () => {
    process.env.GITHUB_RELEASES_TOKEN = 'gh_test_token';
    process.env.DESKTOP_RELEASES_REPO = 'https://github.com/x/y';
    const res = await GET(makeReq(), makeParams(['latest.yml']));
    expect(res.status).toBe(503);
    expect(mockedFetchPublic).not.toHaveBeenCalled();
  });

  it('validates every unauthenticated asset redirect and rejects a later off-domain hop', async () => {
    process.env.GITHUB_RELEASES_TOKEN = 'gh_test_token';
    mockedFetchPublic.mockResolvedValueOnce(
      new Response(JSON.stringify(RELEASE_FIXTURE), { status: 200 })
    );
    mockedResolve.mockImplementation(async (value) => ({
      url: new URL(String(value)),
      addresses: [{ address: '140.82.112.6', family: 4 }],
    }));
    mockedPinned
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location:
              'https://release-assets.githubusercontent.com/github-production-release-asset/1/latest.yml',
          },
        })
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://attacker.example/payload.yml' },
        })
      );

    const res = await GET(makeReq(), makeParams(['latest.yml']));
    expect(res.status).toBe(502);
    expect(mockedPinned).toHaveBeenCalledTimes(2);
    const firstHeaders = new Headers(mockedPinned.mock.calls[0][1]?.headers);
    const secondHeaders = new Headers(mockedPinned.mock.calls[1][1]?.headers);
    expect(firstHeaders.get('authorization')).toBe('Bearer gh_test_token');
    expect(secondHeaders.get('authorization')).toBeNull();
  });
});
