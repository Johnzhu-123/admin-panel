/** @jest-environment node */

import { createHash } from "crypto";

const mockSql = jest.fn();

jest.mock("@vercel/postgres", () => ({
  sql: mockSql,
}));

import {
  createAdminSession,
  hashAdminSessionToken,
  revokeAdminSession,
  validateAdminSession,
} from "../session-store";

describe("DB-backed admin sessions", () => {
  beforeEach(() => {
    mockSql.mockReset();
  });

  it("hashes tokens before persistence", async () => {
    mockSql.mockResolvedValue({ rows: [], rowCount: 1 });
    const token = "raw-session-token";
    const expiresAt = new Date("2030-01-01T00:00:00.000Z");

    await createAdminSession(token, expiresAt);

    const values = mockSql.mock.calls[0].slice(1);
    expect(values).toContain(createHash("sha256").update(token).digest("hex"));
    expect(values).not.toContain(token);
  });

  it("validates only unexpired, non-revoked hashes", async () => {
    mockSql.mockResolvedValue({ rows: [{ valid: true }], rowCount: 1 });

    await expect(validateAdminSession("token")).resolves.toBe(true);

    const [strings, tokenHash] = mockSql.mock.calls[0];
    expect(strings.join(" ")).toMatch(/revoked_at\s+IS\s+NULL/i);
    expect(strings.join(" ")).toMatch(/expires_at\s*>\s*CURRENT_TIMESTAMP/i);
    expect(tokenHash).toBe(hashAdminSessionToken("token"));
  });

  it("propagates database failures so callers can fail closed", async () => {
    mockSql.mockRejectedValue(new Error("database unavailable"));

    await expect(validateAdminSession("token")).rejects.toThrow("database unavailable");
  });

  it("revokes by token hash without persisting the raw token", async () => {
    mockSql.mockResolvedValue({ rows: [], rowCount: 1 });

    await revokeAdminSession("raw-token");

    const values = mockSql.mock.calls[0].slice(1);
    expect(values).toContain(hashAdminSessionToken("raw-token"));
    expect(values).not.toContain("raw-token");
  });
});
