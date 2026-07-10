/** @jest-environment node */

import { createCipheriv } from "crypto";

const KEY = Buffer.alloc(32, 7).toString("base64");

async function loadEncryption() {
  jest.resetModules();
  return import("../encryption");
}

describe("secret encryption", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.BUILT_IN_ENCRYPTION_KEY;
    delete process.env.BUILT_IN_ENCRYPTION_KEY_ID;
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("rejects secret persistence in production when the key is missing", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    const { encryptSecret } = await loadEncryption();

    expect(() => encryptSecret("secret")).toThrow(/encryption key/i);
  });

  it("rejects malformed keys instead of silently deriving a replacement", async () => {
    process.env.BUILT_IN_ENCRYPTION_KEY = "not-a-32-byte-base64-key";
    process.env.BUILT_IN_ENCRYPTION_KEY_ID = "primary";
    const { encryptSecret } = await loadEncryption();

    expect(() => encryptSecret("secret")).toThrow(/32-byte base64/i);
  });

  it("writes v2 ciphertext with a key id and decrypts it", async () => {
    process.env.BUILT_IN_ENCRYPTION_KEY = KEY;
    process.env.BUILT_IN_ENCRYPTION_KEY_ID = "primary-2026";
    const { decryptSecret, encryptSecret } = await loadEncryption();

    const payload = encryptSecret("top-secret");

    expect(payload).toMatch(/^v2::primary-2026::/);
    expect(decryptSecret(payload)).toBe("top-secret");
  });

  it("retains v1 decryption compatibility", async () => {
    process.env.BUILT_IN_ENCRYPTION_KEY = KEY;
    process.env.BUILT_IN_ENCRYPTION_KEY_ID = "primary";
    const key = Buffer.from(KEY, "base64");
    const iv = Buffer.alloc(12, 3);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([
      cipher.update("legacy-secret", "utf8"),
      cipher.final(),
    ]);
    const payload = [
      "v1",
      iv.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      encrypted.toString("base64"),
    ].join("::");
    const { decryptSecret } = await loadEncryption();

    expect(decryptSecret(payload)).toBe("legacy-secret");
  });

  it("rejects unversioned plaintext reads in production", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.BUILT_IN_ENCRYPTION_KEY = KEY;
    process.env.BUILT_IN_ENCRYPTION_KEY_ID = "primary";
    const { decryptSecret } = await loadEncryption();

    expect(decryptSecret("legacy-plaintext-secret")).toBe("");
  });
});
