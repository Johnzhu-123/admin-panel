/** @jest-environment node */

const mockAuth = jest.fn();
jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));

import {
  requireClaimedServicePrincipal,
  requireServicePrincipal,
  ServicePrincipalError,
} from "../service-principal";

describe("service principal", () => {
  beforeEach(() => mockAuth.mockReset());

  it("rejects unsigned legacy identity headers even when they claim a user", async () => {
    const req = new Request("https://admin.example/api/test", {
      headers: {
        authorization: "Bearer clerk-token",
        "x-md2ppt-user-id": "forged-user",
      },
    });
    await expect(requireServicePrincipal(req)).rejects.toBeInstanceOf(ServicePrincipalError);
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it("requires a Bearer credential", async () => {
    await expect(
      requireServicePrincipal(new Request("https://admin.example/api/test"))
    ).rejects.toThrow("Bearer token");
  });

  it("returns only the verified Clerk identity", async () => {
    mockAuth.mockResolvedValue({
      userId: "user_verified",
      sessionClaims: { email: "verified@example.com" },
    });
    await expect(
      requireServicePrincipal(
        new Request("https://admin.example/api/test", {
          headers: { authorization: "Bearer clerk-token" },
        })
      )
    ).resolves.toEqual({
      userId: "user_verified",
      email: "verified@example.com",
      source: "clerk-bearer",
    });
  });

  it("rejects a caller-claimed user that differs from the Clerk principal", async () => {
    mockAuth.mockResolvedValue({
      userId: "user_verified",
      sessionClaims: { email: "verified@example.com" },
    });
    await expect(
      requireClaimedServicePrincipal(
        new Request("https://admin.example/api/test", {
          headers: { authorization: "Bearer clerk-token" },
        }),
        "victim@example.com"
      )
    ).rejects.toMatchObject({ status: 403 });
  });
});
