import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { createClient } from "@vercel/postgres";

const dryRun = process.argv.includes("--dry-run");
const separator = "::";

function loadMaterial() {
  const raw = String(process.env.BUILT_IN_ENCRYPTION_KEY || "").trim();
  const keyId = String(process.env.BUILT_IN_ENCRYPTION_KEY_ID || "").trim();
  if (!raw || !keyId) {
    throw new Error(
      "BUILT_IN_ENCRYPTION_KEY and BUILT_IN_ENCRYPTION_KEY_ID are required"
    );
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) {
    throw new Error("BUILT_IN_ENCRYPTION_KEY_ID has an invalid format");
  }
  const key = Buffer.from(raw, "base64");
  if (
    key.length !== 32 ||
    key.toString("base64").replace(/=+$/, "") !== raw.replace(/=+$/, "")
  ) {
    throw new Error("BUILT_IN_ENCRYPTION_KEY must be valid 32-byte base64");
  }
  return { key, keyId };
}

function decryptKnownSecret(payload, material) {
  const parts = payload.split(separator);
  if (parts[0] === "v2") {
    if (parts.length !== 5) throw new Error("Malformed v2 ciphertext");
    if (parts[1] !== material.keyId) {
      throw new Error(`No key configured for ciphertext keyId ${parts[1]}`);
    }
    return decryptParts(parts.slice(2), material.key);
  }
  if (parts[0] === "v1") {
    if (parts.length !== 4) throw new Error("Malformed v1 ciphertext");
    return decryptParts(parts.slice(1), material.key);
  }
  return payload;
}

function decryptParts(parts, key) {
  const [ivRaw, tagRaw, encryptedRaw] = parts;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivRaw, "base64")
  );
  decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function encryptV2(plain, material) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", material.key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  return [
    "v2",
    material.keyId,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    encrypted.toString("base64"),
  ].join(separator);
}

function migrateObject(value, material) {
  let changed = false;
  function visit(node) {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== "object") return node;
    const result = { ...node };
    for (const [key, child] of Object.entries(result)) {
      if (
        (key === "apiKey" || key === "apiToken") &&
        typeof child === "string" &&
        child.length > 0
      ) {
        if (child.startsWith(`v2${separator}${material.keyId}${separator}`)) {
          continue;
        }
        result[key] = encryptV2(decryptKnownSecret(child, material), material);
        changed = true;
      } else {
        result[key] = visit(child);
      }
    }
    return result;
  }
  return { value: visit(value), changed };
}

const material = loadMaterial();
const client = createClient();
let changedRows = 0;

try {
  await client.connect();
  await client.query("BEGIN");
  const { rows } = await client.query(`
    SELECT setting_key, setting_value
    FROM built_in_system_settings
    WHERE setting_key LIKE 'service_catalog_%'
       OR setting_key = 'mineru_runtime_settings'
    FOR UPDATE
  `);

  for (const row of rows) {
    let parsed;
    try {
      parsed = JSON.parse(row.setting_value);
    } catch {
      throw new Error(`Setting ${row.setting_key} is not valid JSON`);
    }
    const migrated = migrateObject(parsed, material);
    if (!migrated.changed) continue;
    changedRows += 1;
    if (!dryRun) {
      await client.query(
        `UPDATE built_in_system_settings
         SET setting_value = $1, updated_at = CURRENT_TIMESTAMP
         WHERE setting_key = $2`,
        [JSON.stringify(migrated.value), row.setting_key]
      );
    }
  }

  if (dryRun) await client.query("ROLLBACK");
  else await client.query("COMMIT");
  console.log(
    `${dryRun ? "Dry run" : "Migration"} completed; ${changedRows} row(s) require update.`
  );
} catch (error) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original error.
  }
  console.error(
    "Encrypted secret migration failed:",
    error instanceof Error ? error.message : error
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
