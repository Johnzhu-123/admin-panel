import {
  getMinerUIdentityFromClerkUser,
  getMinerUIdentityFromRequestHeaders,
  findMinerUAuthorizationRecord,
  isMinerUServiceAllowed,
  parseMinerUAuthorizedUsersFromEnv,
} from "../mineru-authorization";

describe("MinerU authorization helpers", () => {
  it("extracts the same desktop identity from forwarded headers that local Clerk resolved", () => {
    const headers = new Headers({
      "x-md2ppt-user-id": "user_123",
      "x-md2ppt-user-email": "owner@example.com",
    });

    expect(getMinerUIdentityFromRequestHeaders(headers)).toEqual({
      userId: "user_123",
      email: "owner@example.com",
      source: "desktop-proxy",
    });
  });

  it("uses Clerk email and id when the admin-panel request has a remote Clerk session", () => {
    expect(
      getMinerUIdentityFromClerkUser({
        id: "user_abc",
        primaryEmailAddress: { emailAddress: "me@example.com" },
        emailAddresses: [{ emailAddress: "fallback@example.com" }],
      })
    ).toEqual({
      userId: "user_abc",
      email: "me@example.com",
      source: "clerk",
    });
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
