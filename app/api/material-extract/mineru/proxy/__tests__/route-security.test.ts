/** @jest-environment node */

const requireServicePrincipal = jest.fn();
const getMinerURuntimeSettings = jest.fn();
const sql = jest.fn();
const fetchPublicHttpUrl = jest.fn();
const acquire = jest.fn();
const release = jest.fn();

jest.mock("@/lib/auth/service-principal", () => ({
  requireServicePrincipal: (...args: unknown[]) => requireServicePrincipal(...args),
  ServicePrincipalError: class ServicePrincipalError extends Error {
    status = 401;
  },
}));
jest.mock("@/lib/built-in-api-service/mineru-settings", () => ({
  getMinerURuntimeSettings: () => getMinerURuntimeSettings(),
}));
jest.mock("@vercel/postgres", () => ({
  sql: (...args: unknown[]) => sql(...args),
}));
jest.mock("@/lib/network/public-url", () => ({
  fetchPublicHttpUrl: (...args: unknown[]) => fetchPublicHttpUrl(...args),
}));
jest.mock("@/lib/built-in-api-service/quota-service", () => ({
  quotaService: {
    acquire: (...args: unknown[]) => acquire(...args),
    release: (...args: unknown[]) => release(...args),
  },
}));
jest.mock("@/lib/ai", () => ({ noStoreHeaders: () => ({ "cache-control": "no-store" }) }));

import { GET, POST } from "../route";

describe("admin MinerU proxy security", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getMinerURuntimeSettings.mockResolvedValue({
      enabled: true,
      apiToken: "mineru-secret",
      baseUrl: "https://mineru.net",
    });
    requireServicePrincipal.mockResolvedValue({
      userId: "user_1",
      email: "user@example.com",
      source: "clerk-bearer",
    });
    acquire.mockResolvedValue({ acquired: true, reservationId: "reservation_1" });
    release.mockResolvedValue({ released: true, changed: true });
    sql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("FROM authorized_users")) {
        return Promise.resolve({ rows: [{
          user_id: "user_1",
          email: "user@example.com",
          status: "active",
          can_use_built_in_services: true,
          allowed_services: ["mineru"],
          daily_requests: 100,
          monthly_requests: 1000,
          concurrent_requests: 2,
        }] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  it("rejects non-allowlisted operations before quota or dispatch", async () => {
    const response = await POST(new Request("https://admin.example/api/material-extract/mineru/proxy", {
      method: "POST",
      headers: { "x-mineru-target-path": "/api/v4/extract-results/batch/../admin" },
    }) as never);
    expect(response.status).toBe(405);
    expect(acquire).not.toHaveBeenCalled();
    expect(fetchPublicHttpUrl).not.toHaveBeenCalled();
  });

  it("uses pinned HTTPS, rejects redirects, and always releases the reservation", async () => {
    fetchPublicHttpUrl.mockRejectedValue(new Error("redirect rejected"));
    const response = await GET(new Request("https://admin.example/api/material-extract/mineru/proxy", {
      method: "GET",
      headers: {
        authorization: "Bearer clerk-token",
        "x-mineru-target-path": "/api/v4/extract-results/batch/task_123",
      },
    }) as never);
    expect(response.status).toBe(502);
    expect(fetchPublicHttpUrl).toHaveBeenCalledWith(
      "https://mineru.net/api/v4/extract-results/batch/task_123",
      expect.objectContaining({ redirect: "manual" }),
      expect.objectContaining({ maxRedirects: 0, allowHttp: false, allowPrivateNetwork: false })
    );
    expect(release).toHaveBeenCalledWith("reservation_1");
  });

  it("fails closed when quota persistence is unavailable", async () => {
    acquire.mockResolvedValue({ acquired: false, reason: "database_error" });
    const response = await POST(new Request("https://admin.example/api/material-extract/mineru/proxy", {
      method: "POST",
      headers: {
        authorization: "Bearer clerk-token",
        "x-mineru-target-path": "/api/v4/file-urls/batch",
      },
      body: "{}",
    }) as never);
    expect(response.status).toBe(503);
    expect(fetchPublicHttpUrl).not.toHaveBeenCalled();
  });

  it("keeps the successful reservation until the response stream is consumed", async () => {
    fetchPublicHttpUrl.mockResolvedValue(
      new Response("mineru-ok", { status: 200 })
    );
    const response = await GET(new Request("https://admin.example/api/material-extract/mineru/proxy", {
      headers: {
        authorization: "Bearer clerk-token",
        "x-mineru-target-path": "/api/v4/extract-results/batch/task_123",
      },
    }) as never);
    expect(release).not.toHaveBeenCalled();
    await expect(response.text()).resolves.toBe("mineru-ok");
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith("reservation_1");
  });
});
