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
import { GET } from '../route';

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

const originalFetch = global.fetch;
const originalToken = process.env.GITHUB_RELEASES_TOKEN;

describe('GET /api/desktop-update/[[...path]]', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GITHUB_RELEASES_TOKEN;
    else process.env.GITHUB_RELEASES_TOKEN = originalToken;
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
    global.fetch = jest.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/releases/latest')) {
        return new Response(JSON.stringify(RELEASE_FIXTURE), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // asset download
      return new Response(yamlBody, { status: 200 });
    }) as unknown as typeof fetch;

    const res = await GET(makeReq(), makeParams(['latest.yml']));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/yaml');
    expect(res.headers.get('x-release-tag')).toBe('v1.0.1');
    expect(await res.text()).toBe(yamlBody);
    // 第一跳必须带鉴权访问 GitHub API
    const firstCall = (global.fetch as jest.Mock).mock.calls[0] as unknown[];
    expect(String(firstCall[0])).toContain('/releases/latest');
  });

  it('returns 404 naming the release tag when asset is missing', async () => {
    process.env.GITHUB_RELEASES_TOKEN = 'gh_test_token';
    global.fetch = jest.fn(async () =>
      new Response(JSON.stringify(RELEASE_FIXTURE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    ) as unknown as typeof fetch;

    const res = await GET(makeReq(), makeParams(['not-exist.exe']));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain('v1.0.1');
  });
});
