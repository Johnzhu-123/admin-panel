/**
 * AES-256-GCM 加解密工具
 * 用于在 Postgres 中加密存储 API Key 等敏感字段
 *
 * 环境变量：
 *   BUILT_IN_ENCRYPTION_KEY  base64 编码的 32 字节 AES-256 密钥
 *
 * 生成方式：
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";

const ENC_VERSION = "v1";
const SEPARATOR = "::";

let cachedKey: Buffer | null = null;
let warned = false;

function loadKey(): Buffer | null {
  if (cachedKey) return cachedKey;
  const raw = process.env.BUILT_IN_ENCRYPTION_KEY;
  if (!raw) {
    if (!warned) {
      console.warn(
        "[encryption] BUILT_IN_ENCRYPTION_KEY 未设置，敏感字段将以明文存储（仅适合本地开发）"
      );
      warned = true;
    }
    return null;
  }

  let buf: Buffer;
  try {
    buf = Buffer.from(raw.trim(), "base64");
    if (buf.length !== 32) {
      buf = createHash("sha256").update(raw).digest();
    }
  } catch {
    buf = createHash("sha256").update(raw).digest();
  }
  cachedKey = buf;
  return cachedKey;
}

export function isEncryptionConfigured(): boolean {
  return Boolean(process.env.BUILT_IN_ENCRYPTION_KEY);
}

export function encryptSecret(plain: string): string {
  if (!plain) return "";
  const key = loadKey();
  if (!key) return plain;

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENC_VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    enc.toString("base64"),
  ].join(SEPARATOR);
}

export function decryptSecret(payload: string): string {
  if (!payload) return "";

  const parts = payload.split(SEPARATOR);
  if (parts.length !== 4 || parts[0] !== ENC_VERSION) {
    return payload;
  }

  const key = loadKey();
  if (!key) return "";

  try {
    const iv = Buffer.from(parts[1], "base64");
    const tag = Buffer.from(parts[2], "base64");
    const enc = Buffer.from(parts[3], "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString("utf8");
  } catch (error) {
    console.error("[encryption] 解密失败:", error instanceof Error ? error.message : error);
    return "";
  }
}

export function maskSecret(secret: string, visibleHead = 4, visibleTail = 4): string {
  if (!secret) return "";
  if (secret.length <= visibleHead + visibleTail) {
    return "*".repeat(secret.length);
  }
  return (
    secret.slice(0, visibleHead) +
    "*".repeat(Math.max(8, secret.length - visibleHead - visibleTail)) +
    secret.slice(-visibleTail)
  );
}
