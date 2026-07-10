import { createHash } from "crypto";
import { sql } from "@vercel/postgres";

export function hashAdminSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function createAdminSession(
  token: string,
  expiresAt: Date
): Promise<void> {
  const tokenHash = hashAdminSessionToken(token);
  await sql`
    WITH cleanup AS (
      DELETE FROM admin_sessions
      WHERE expires_at <= CURRENT_TIMESTAMP
         OR revoked_at < CURRENT_TIMESTAMP - INTERVAL '7 days'
    )
    INSERT INTO admin_sessions (token_hash, created_at, expires_at, revoked_at)
    VALUES (${tokenHash}, CURRENT_TIMESTAMP, ${expiresAt.toISOString()}::timestamptz, NULL)
    ON CONFLICT (token_hash)
    DO UPDATE SET
      created_at = CURRENT_TIMESTAMP,
      expires_at = EXCLUDED.expires_at,
      revoked_at = NULL
  `;
}

export async function validateAdminSession(token: string): Promise<boolean> {
  const tokenHash = hashAdminSessionToken(token);
  const { rows } = await sql<{ valid: boolean }>`
    SELECT EXISTS (
      SELECT 1
      FROM admin_sessions
      WHERE token_hash = ${tokenHash}
        AND revoked_at IS NULL
        AND expires_at > CURRENT_TIMESTAMP
    ) AS valid
  `;
  return rows[0]?.valid === true;
}

export async function revokeAdminSession(token: string): Promise<void> {
  const tokenHash = hashAdminSessionToken(token);
  await sql`
    UPDATE admin_sessions
    SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
    WHERE token_hash = ${tokenHash}
  `;
}
