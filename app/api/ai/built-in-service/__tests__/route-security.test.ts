/** @jest-environment node */

const requireServicePrincipal = jest.fn();
const requireAdminSession = jest.fn();
const addAuthorizedUser = jest.fn();

jest.mock("@/lib/auth/service-principal", () => ({
  requireServicePrincipal: (...args: unknown[]) => requireServicePrincipal(...args),
  ServicePrincipalError: class ServicePrincipalError extends Error {
    status = 401;
  },
}));
jest.mock("@/app/api/admin/_auth", () => ({
  requireAdminSession: () => requireAdminSession(),
}));
jest.mock("@/lib/ai", () => ({ noStoreHeaders: () => ({ "cache-control": "no-store" }) }));
jest.mock("@/lib/built-in-api-service", () => ({
  getBuiltInAPIService: () => ({
    initialize: jest.fn(),
    addAuthorizedUser,
    clearCaches: jest.fn(),
  }),
}));
jest.mock("@/lib/built-in-api-service/db", () => ({
  getBuiltInRuntimeSettings: jest.fn(),
  sanitizeServiceCatalog: jest.fn(),
  getSubtaskPresets: jest.fn(),
  getUserServiceUsageStats: jest.fn(),
}));

import { POST } from "../route";

describe("built-in service route security", () => {
  beforeEach(() => {
    requireServicePrincipal.mockReset();
    requireAdminSession.mockReset();
    addAuthorizedUser.mockReset();
    requireServicePrincipal.mockResolvedValue({
      userId: "admin_clerk_user",
      email: "admin@example.com",
      source: "clerk-bearer",
    });
  });

  it("rejects a forged target user on self-service actions", async () => {
    const response = await POST(new Request("https://admin.example/api/ai/built-in-service", {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ action: "switch-to-built-in", userId: "victim", serviceId: "svc" }),
    }));
    expect(response.status).toBe(403);
  });

  it("requires the persistent admin session before management actions", async () => {
    requireAdminSession.mockResolvedValue(
      Response.json({ error: "Unauthorized" }, { status: 401 })
    );
    const response = await POST(new Request("https://admin.example/api/ai/built-in-service", {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ action: "add-user", userId: "target", permissions: {} }),
    }));
    expect(response.status).toBe(401);
    expect(addAuthorizedUser).not.toHaveBeenCalled();
  });
});
