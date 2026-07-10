/** @jest-environment node */

import { createServer, type Server } from "node:http";
import {
  fetchPublicHttpUrl,
  resolvePublicHttpTarget,
} from "@/lib/network/public-url";
import {
  requestPinnedHttpTarget,
  type ResolvedHttpTarget,
} from "@/lib/network/pinned-http";

const listen = (server: Server) =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Missing server address"));
        return;
      }
      resolve(address.port);
    });
  });

const close = (server: Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

describe("public URL resolution", () => {
  it("returns the exact validated DNS addresses for the later connection", async () => {
    const lookupFn = jest.fn(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]) as any;

    const target = await resolvePublicHttpTarget(
      "https://example.com/a",
      { allowHttp: false },
      undefined,
      lookupFn
    );

    expect(lookupFn).toHaveBeenCalledTimes(1);
    expect(target.url.hostname).toBe("example.com");
    expect(target.addresses).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);
  });

  it("rejects the whole DNS answer when any address is private", async () => {
    const lookupFn = jest.fn(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]) as any;

    await expect(
      resolvePublicHttpTarget(
        "https://example.com/",
        {},
        undefined,
        lookupFn
      )
    ).rejects.toThrow(/内网|回环|保留/);
  });
});

describe("pinned HTTP connection", () => {
  let server: Server;
  let port = 0;
  let requestCount = 0;

  beforeEach(async () => {
    requestCount = 0;
    server = createServer((req, res) => {
      requestCount += 1;
      if (req.url === "/slow") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("partial");
        return;
      }
      if (req.url === "/empty") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.headers.host?.startsWith("first.example")) {
        res.writeHead(302, {
          location: `http://second.example:${port}/final`,
        });
        res.end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ host: req.headers.host, url: req.url }));
    });
    port = await listen(server);
  });

  afterEach(async () => {
    await close(server);
  });

  const target = (): ResolvedHttpTarget => ({
    url: new URL(`http://public.example:${port}/probe?q=1`),
    addresses: [{ address: "127.0.0.1", family: 4 }],
  });

  it("connects to the pinned IP while preserving the original Host header", async () => {
    const response = await requestPinnedHttpTarget(target(), {
      headers: { host: "attacker.invalid", connection: "keep-alive" },
    });
    await expect(response.json()).resolves.toEqual({
      host: `public.example:${port}`,
      url: "/probe?q=1",
    });
  });

  it("may try another validated address for an idempotent request", async () => {
    const response = await requestPinnedHttpTarget({
      ...target(),
      addresses: [
        { address: "127.0.0.2", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    });
    expect(response.status).toBe(200);
  });

  it("does not replay a non-idempotent request on another address", async () => {
    await expect(
      requestPinnedHttpTarget(
        {
          ...target(),
          addresses: [
            { address: "127.0.0.2", family: 4 },
            { address: "127.0.0.1", family: 4 },
          ],
        },
        { method: "POST", body: "payload" }
      )
    ).rejects.toBeDefined();
    expect(requestCount).toBe(0);
  });

  it("keeps the abort signal attached while the response body is streaming", async () => {
    const controller = new AbortController();
    const response = await requestPinnedHttpTarget(
      {
        url: new URL(`http://public.example:${port}/slow`),
        addresses: [{ address: "127.0.0.1", family: 4 }],
      },
      { signal: controller.signal }
    );
    const body = response.text();
    controller.abort(new DOMException("deadline", "TimeoutError"));
    await expect(body).rejects.toMatchObject({ name: "AbortError" });
  });

  it("constructs bodyless responses for statuses that forbid a body", async () => {
    const response = await requestPinnedHttpTarget({
      url: new URL(`http://public.example:${port}/empty`),
      addresses: [{ address: "127.0.0.1", family: 4 }],
    });
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it("resolves and pins every redirect target independently", async () => {
    const lookupFn = jest.fn(async () => [
      { address: "127.0.0.1", family: 4 },
    ]) as any;
    const response = await fetchPublicHttpUrl(
      `http://first.example:${port}/start`,
      {},
      {
        allowHttp: true,
        allowPrivateNetwork: true,
        lookupFn,
      }
    );

    await expect(response.json()).resolves.toEqual({
      host: `second.example:${port}`,
      url: "/final",
    });
    expect(lookupFn).toHaveBeenCalledTimes(2);
    expect(lookupFn.mock.calls.map(([hostname]) => hostname)).toEqual([
      "first.example",
      "second.example",
    ]);
  });
});
