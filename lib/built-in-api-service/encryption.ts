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

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ENC_VERSION_V1 = "v1";
const ENC_VERSION_V2 = "v2";
const SEPARATOR = "::";

let cachedMaterial: { raw: string; keyId: string; key: Buffer } | null = null;
let warned = false;

function loadKey(): { key: Buffer; keyId: string } | null {
  const raw = process.env.BUILT_IN_ENCRYPTION_KEY?.trim();
  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "Encryption key BUILT_IN_ENCRYPTION_KEY is required for production secret persistence"
      );
    }
    if (!warned) {
      console.warn(
        "[encryption] BUILT_IN_ENCRYPTION_KEY 未设置，敏感字段将以明文存储（仅适合本地开发）"
      );
      warned = true;
    }
    return null;
  }

  const keyId = (process.env.BUILT_IN_ENCRYPTION_KEY_ID || "").trim();
  if (!keyId && process.env.NODE_ENV === "production") {
    throw new Error(
      "Encryption key id BUILT_IN_ENCRYPTION_KEY_ID is required for production secret persistence"
    );
  }
  const resolvedKeyId = keyId || "default";
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(resolvedKeyId)) {
    throw new Error("BUILT_IN_ENCRYPTION_KEY_ID has an invalid format");
  }
  if (cachedMaterial?.raw === raw && cachedMaterial.keyId === resolvedKeyId) {
    return cachedMaterial;
  }

  const key = Buffer.from(raw, "base64");
  const normalizedInput = raw.replace(/=+$/, "");
  const normalizedDecoded = key.toString("base64").replace(/=+$/, "");
  if (key.length !== 32 || normalizedDecoded !== normalizedInput) {
    throw new Error(
      "BUILT_IN_ENCRYPTION_KEY must be a valid 32-byte base64 value"
    );
  }
  cachedMaterial = { raw, keyId: resolvedKeyId, key };
  return cachedMaterial;
}

export function isEncryptionConfigured(): boolean {
  try {
    return loadKey() !== null;
  } catch {
    return false;
  }
}

export function encryptSecret(plain: string): string {
  if (!plain) return "";
  const material = loadKey();
  if (!material) return plain;

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", material.key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENC_VERSION_V2,
    material.keyId,
    iv.toString("base64"),
    tag.toString("base64"),
    enc.toString("base64"),
  ].join(SEPARATOR);
}

export function decryptSecret(payload: string): string {
  if (!payload) return "";

  const parts = payload.split(SEPARATOR);
  const isV1 = parts.length === 4 && parts[0] === ENC_VERSION_V1;
  const isV2 = parts.length === 5 && parts[0] === ENC_VERSION_V2;
  if (!isV1 && !isV2) {
    if (process.env.NODE_ENV === "production") {
      console.error(
        "[encryption] 拒绝读取未迁移的生产明文秘密；请先运行秘密迁移与验证脚本"
      );
      return "";
    }
    return payload;
  }

  let material: { key: Buffer; keyId: string } | null;
  try {
    material = loadKey();
  } catch (error) {
    console.error(
      "[encryption] 解密密钥不可用:",
      error instanceof Error ? error.message : "unknown error"
    );
    return "";
  }
  if (!material) return "";

  try {
    const offset = isV2 ? 1 : 0;
    if (isV2 && parts[1] !== material.keyId) {
      console.error(`[encryption] 未配置 ciphertext keyId: ${parts[1]}`);
      return "";
    }
    const iv = Buffer.from(parts[1 + offset], "base64");
    const tag = Buffer.from(parts[2 + offset], "base64");
    const enc = Buffer.from(parts[3 + offset], "base64");
    const decipher = createDecipheriv("aes-256-gcm", material.key, iv);
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
