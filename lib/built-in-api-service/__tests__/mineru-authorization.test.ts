import {
  getMinerUIdentityFromServicePrincipal,
  findMinerUAuthorizationRecord,
  isMinerUServiceAllowed,
  normalizeMinerUCloudBaseUrl,
  parseMinerUAuthorizedUsersFromEnv,
  resolveAllowedMinerUOperation,
} from "../mineru-authorization";

describe("MinerU authorization helpers", () => {
  it("derives identity only from a verified Clerk service principal", () => {
    expect(getMinerUIdentityFromServicePrincipal({
      userId: "user_123",
      email: "owner@example.com",
      source: "clerk-bearer",
    })).toEqual({
      userId: "user_123",
      email: "owner@example.com",
      source: "clerk-bearer",
    });
  });

  it("enforces the exact MinerU origin and operation allowlist", () => {
    expect(normalizeMinerUCloudBaseUrl("https://mineru.net")).toBe("https://mineru.net");
    expect(normalizeMinerUCloudBaseUrl("http://mineru.net")).toBeNull();
    expect(normalizeMinerUCloudBaseUrl("https://evil.example")).toBeNull();
    expect(resolveAllowedMinerUOperation("POST", "/api/v4/file-urls/batch")).toEqual({
      method: "POST",
      path: "/api/v4/file-urls/batch",
    });
    expect(resolveAllowedMinerUOperation("GET", "/api/v4/extract-results/batch/task_01-A")).toEqual({
      method: "GET",
      path: "/api/v4/extract-results/batch/task_01-A",
    });
    for (const unsafe of [
      "/api/v4/extract-results/batch/../admin",
      "/api/v4/extract-results/batch/a%2Fb",
      "/api/v4/extract-results/batch/.hidden",
      "/api/v4/other",
    ]) {
      expect(resolveAllowedMinerUOperation("GET", unsafe)).toBeNull();
    }
    expect(resolveAllowedMinerUOperation("DELETE", "/api/v4/file-urls/batch")).toBeNull();
  });

  it("treats historical built-in service permission as enough for MinerU", () => {
    expect(isMinerUServiceAllowed([])).toBe(true);
    expect(isMinerUServiceAllowed(["gemini-built-in"])).toBe(true);
    expect(isMinerUServiceAllowed(["built-in-default"])).toBe(true);
    expect(isMinerUServiceAllowed(["mineru"])).toBe(true);
    expect(isMinerUServiceAllowed(["material-extract"])).toBe(true);
    expect(isMinerUServiceAllowed(["*"])).toBe(true);
    expect(isMinerUServiceAllowed(["video"])).toBe(false);
  });

  it("finds MinerU authorization from AUTHORIZED_USERS-style environment records by email", () => {
    const users = parseMinerUAuthorizedUsersFromEnv(JSON.stringify([
      {
        userId: "user_other",
        email: "other@example.com",
        permissions: {
          canUseBuiltInServices: true,
          allowedServices: ["gemini-built-in"],
          quotaLimits: { dailyRequests: 10, monthlyRequests: 100 },
        },
      },
      {
        userId: "user_env",
        email: "Owner@Example.com",
        status: "active",
        permissions: {
          canUseBuiltInServices: true,
          allowedServices: ["gemini-built-in"],
          quotaLimits: { dailyRequests: 50, monthlyRequests: 1000 },
        },
      },
    ]));

    expect(findMinerUAuthorizationRecord(users, "missing-user", "owner@example.com")).toMatchObject({
      userId: "user_env",
      email: "Owner@Example.com",
      status: "active",
      canUseBuiltInServices: true,
      allowedServices: ["gemini-built-in"],
      dailyRequests: 50,
      monthlyRequests: 1000,
    });
  });
});
