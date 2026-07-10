/** @jest-environment node */

import { NextRequest } from "next/server";
import { requireServicePrincipal } from "@/lib/auth/service-principal";
import { getInternalServiceConfig } from "@/lib/built-in-api-service/db";
import { quotaService } from "@/lib/built-in-api-service/quota-service";
import { fetchPublicHttpUrl } from "@/lib/network/public-url";
import { sql } from "@vercel/postgres";
import { POST } from "../route";

jest.mock("@vercel/postgres", () => ({ sql: jest.fn() }));
jest.mock("@/lib/auth/service-principal", () => ({
  requireServicePrincipal: jest.fn(),
  ServicePrincipalError: class ServicePrincipalError extends Error {
    constructor(message: string, public status = 401) {
      super(message);
    }
  },
}));
jest.mock("@/lib/built-in-api-service/db", () => ({
  BUILT_IN_SERVICE_CATEGORIES: ["text", "image", "tts", "video", "multimodal"],
  getInternalServiceConfig: jest.fn(),
}));
jest.mock("@/lib/built-in-api-service/quota-service", () => ({
  quotaService: {
    acquire: jest.fn(),
    release: jest.fn(),
  },
}));
jest.mock("@/lib/network/public-url", () => ({
  fetchPublicHttpUrl: jest.fn(),
}));

const mockedPrincipal = requireServicePrincipal as jest.MockedFunction<
  typeof requireServicePrincipal
>;
const mockedConfig = getInternalServiceConfig as jest.MockedFunction<
  typeof getInternalServiceConfig
>;
const mockedAcquire = quotaService.acquire as jest.MockedFunction<
  typeof quotaService.acquire
>;
const mockedRelease = quotaService.release as jest.MockedFunction<
  typeof quotaService.release
>;
const mockedFetch = fetchPublicHttpUrl as jest.MockedFunction<
  typeof fetchPublicHttpUrl
>;
const mockSql = sql as jest.MockedFunction<typeof sql>;

const context = {
  params: Promise.resolve({ category: "text", subpath: ["chat", "completions"] }),
};

const request = (headers: Record<string, string> = {}) =>
  new NextRequest("https://admin.example/api/proxy/ai/text/chat/completions?subtask=plan", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer verified",
      "x-md2ppt-user-id": "forged",
      ...headers,
    },
    body: JSON.stringify({ prompt: "hello" }),
  });

describe("atomic built-in AI proxy quota and egress", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedPrincipal.mockResolvedValue({
      userId: "user_1",
      email: "user@example.com",
      source: "clerk-bearer",
    });
    mockSql.mockResolvedValue({
      rows: [
        {
          user_id: "user_1",
          email: "user@example.com",
          status: "active",
          can_use_built_in_services: true,
          allowed_services: ["text"],
          daily_requests: 10,
          monthly_requests: 100,
          concurrent_requests: 2,
        },
      ],
    } as never);
    mockedConfig.mockResolvedValue({
      category: "text",
      subtask: {
        id: "plan",
        displayName: "Plan",
        baseUrl: "https://api.example.com",
        apiKey: "upstream-secret",
        model: "model-1",
        models: ["model-1"],
        isEnabled: true,
      },
    } as never);
    mockedAcquire.mockResolvedValue({
      acquired: true,
      reservationId: "reservation-1",
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      usage: { daily: 1, monthly: 1, concurrent: 1 },
    });
    mockedRelease.mockResolvedValue({ released: true, changed: true });
    mockedFetch.mockResolvedValue(
      new Response("upstream-ok", {
        status: 200,
        headers: { "content-type": "text/plain" },
      })
    );
  });

  it("acquires before dispatch, pins egress, strips forged identity, and releases after streaming", async () => {
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect(mockedAcquire).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_1",
        serviceId: "built-in-text-plan",
        limits: {
          dailyRequests: 10,
          monthlyRequests: 100,
          concurrentRequests: 2,
        },
      })
    );
    const [url, init, policy] = mockedFetch.mock.calls[0];
    expect(String(url)).toBe("https://api.example.com/v1/chat/completions");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer upstream-secret");
    expect(headers.get("x-md2ppt-user-id")).toBeNull();
    expect(policy).toMatchObject({ allowHttp: false, maxRedirects: 0 });
    expect(mockedRelease).not.toHaveBeenCalled();

    await expect(response.text()).resolves.toBe("upstream-ok");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockedRelease).toHaveBeenCalledWith("reservation-1");
  });

  it("fails closed when authorization storage is unavailable", async () => {
    mockSql.mockRejectedValueOnce(new Error("database unavailable"));
    const response = await POST(request(), context);
    expect(response.status).toBe(503);
    expect(mockedAcquire).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("fails closed when the quota store is unavailable", async () => {
    mockedAcquire.mockResolvedValue({ acquired: false, reason: "database_error" });
    const response = await POST(request(), context);
    expect(response.status).toBe(503);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies before reserving or dispatching", async () => {
    const response = await POST(
      request({ "content-length": String(25 * 1024 * 1024 + 1) }),
      context
    );
    expect(response.status).toBe(413);
    expect(mockedAcquire).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
