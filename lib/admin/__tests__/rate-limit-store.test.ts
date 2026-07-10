/** @jest-environment node */

const mockSql = jest.fn();

jest.mock("@vercel/postgres", () => ({
  sql: mockSql,
}));

import {
  consumeAdminLoginAttempt,
  hashAdminClientIdentifier,
  resolveAdminClientIdentifier,
} from "../rate-limit-store";

describe("persistent admin login rate limiting", () => {
  beforeEach(() => {
    mockSql.mockReset();
    delete process.env.ADMIN_TRUST_PROXY_HEADERS;
    delete process.env.VERCEL;
  });

  it("does not trust generic forwarded headers by default", () => {
    const headers = new Headers({
      "x-forwarded-for": "198.51.100.10, 10.0.0.2",
      "x-real-ip": "198.51.100.11",
    });

    expect(resolveAdminClientIdentifier(headers)).toBe("untrusted-client");
  });

  it("uses the nearest valid forwarded address only when proxy trust is explicit", () => {
    process.env.ADMIN_TRUST_PROXY_HEADERS = "1";
    const headers = new Headers({
      "x-forwarded-for": "198.51.100.10, 203.0.113.8",
    });

    expect(resolveAdminClientIdentifier(headers)).toBe("203.0.113.8");
  });

  it("uses Vercel's platform-owned client address header", () => {
    process.env.VERCEL = "1";
    const headers = new Headers({
      "x-vercel-forwarded-for": "198.51.100.25",
      "x-forwarded-for": "203.0.113.99",
    });

    expect(resolveAdminClientIdentifier(headers)).toBe("198.51.100.25");
  });

  it("atomically updates global and per-client windows without storing raw identifiers", async () => {
    mockSql.mockResolvedValue({
      rows: [{ allowed: false, retry_after_seconds: 42 }],
      rowCount: 1,
    });

    const result = await consumeAdminLoginAttempt("198.51.100.10");

    expect(result).toEqual({ allowed: false, retryAfterSeconds: 42 });
    const [strings, ...values] = mockSql.mock.calls[0];
    const statement = strings.join(" ");
    expect(statement).toMatch(/ON\s+CONFLICT/i);
    expect(statement).toMatch(/scope/i);
    expect(statement).toMatch(/global/i);
    expect(statement).toMatch(/client/i);
    expect(values).toContain(hashAdminClientIdentifier("198.51.100.10"));
    expect(values).not.toContain("198.51.100.10");
  });

  it("propagates database failures", async () => {
    mockSql.mockRejectedValue(new Error("database unavailable"));

    await expect(consumeAdminLoginAttempt("client")).rejects.toThrow(
      "database unavailable"
    );
  });
});
