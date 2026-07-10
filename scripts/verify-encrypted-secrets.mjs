import { createDecipheriv } from "node:crypto";
import { createClient } from "@vercel/postgres";

const separator = "::";
const raw = String(process.env.BUILT_IN_ENCRYPTION_KEY || "").trim();
const configuredKeyId = String(
  process.env.BUILT_IN_ENCRYPTION_KEY_ID || ""
).trim();
const key = raw ? Buffer.from(raw, "base64") : null;

if (!raw || !configuredKeyId) {
  throw new Error(
    "BUILT_IN_ENCRYPTION_KEY and BUILT_IN_ENCRYPTION_KEY_ID are required"
  );
}
if (!/^[A-Za-z0-9._-]{1,64}$/.test(configuredKeyId)) {
  throw new Error("BUILT_IN_ENCRYPTION_KEY_ID has an invalid format");
}
if (
  key.length !== 32 ||
  key.toString("base64").replace(/=+$/, "") !== raw.replace(/=+$/, "")
) {
  throw new Error("BUILT_IN_ENCRYPTION_KEY must be valid 32-byte base64");
}

function findSecrets(node, path = "$") {
  const results = [];
  if (Array.isArray(node)) {
    node.forEach((item, index) => {
      results.push(...findSecrets(item, `${path}[${index}]`));
    });
    return results;
  }
  if (!node || typeof node !== "object") return results;
  for (const [name, value] of Object.entries(node)) {
    const childPath = `${path}.${name}`;
    if (
      (name === "apiKey" || name === "apiToken") &&
      typeof value === "string" &&
      value.length > 0
    ) {
      results.push({ path: childPath, value });
    } else {
      results.push(...findSecrets(value, childPath));
    }
  }
  return results;
}

function verifyCiphertext(payload) {
  const parts = payload.split(separator);
  if (parts.length !== 5 || parts[0] !== "v2" || !parts[1]) {
    return "secret is plaintext, malformed, or still v1";
  }
  if (parts[1] !== configuredKeyId) {
    return `ciphertext keyId ${parts[1]} does not match configured keyId`;
  }
  if (parts[1] === configuredKeyId && key.length === 32) {
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(parts[2], "base64")
      );
      decipher.setAuthTag(Buffer.from(parts[3], "base64"));
      Buffer.concat([
        decipher.update(Buffer.from(parts[4], "base64")),
        decipher.final(),
      ]);
    } catch {
      return "ciphertext cannot be decrypted with the configured key";
    }
  }
  return null;
}

const client = createClient();
const failures = [];
let secretCount = 0;

try {
  await client.connect();
  const { rows } = await client.query(`
    SELECT setting_key, setting_value
    FROM built_in_system_settings
    WHERE setting_key LIKE 'service_catalog_%'
       OR setting_key = 'mineru_runtime_settings'
    ORDER BY setting_key
  `);
  for (const row of rows) {
    let parsed;
    try {
      parsed = JSON.parse(row.setting_value);
    } catch {
      failures.push(`${row.setting_key}: invalid JSON`);
      continue;
    }
    for (const secret of findSecrets(parsed)) {
      secretCount += 1;
      const error = verifyCiphertext(secret.value);
      if (error) failures.push(`${row.setting_key}${secret.path}: ${error}`);
    }
  }

  if (failures.length > 0) {
    console.error("Encrypted secret verification failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`Encrypted secret verification passed for ${secretCount} secret(s).`);
  }
} catch (error) {
  console.error(
    "Encrypted secret verification failed:",
    error instanceof Error ? error.message : error
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
