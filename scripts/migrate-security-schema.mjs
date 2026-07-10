import { createClient } from "@vercel/postgres";

const client = /** @type {any} */ (
  process.env.POSTGRES_USE_NODE_PG === "1"
    ? new (await import("pg")).Client({
        connectionString:
          process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL,
      })
    : createClient()
);

try {
  await client.connect();
  await client.query("BEGIN");
  await client.query(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash CHAR(64) PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at
    ON admin_sessions (expires_at)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_admin_sessions_active
    ON admin_sessions (expires_at)
    WHERE revoked_at IS NULL
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS admin_login_rate_limits (
      scope VARCHAR(16) NOT NULL CHECK (scope IN ('global', 'client')),
      identifier_hash CHAR(64) NOT NULL,
      window_started_at TIMESTAMPTZ NOT NULL,
      window_expires_at TIMESTAMPTZ NOT NULL,
      attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (scope, identifier_hash)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_admin_login_rate_limits_expiry
    ON admin_login_rate_limits (window_expires_at)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_admin_login_rate_limits_updated
    ON admin_login_rate_limits (updated_at)
    WHERE scope = 'client'
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS api_quota_counters (
      user_id VARCHAR(255) NOT NULL,
      service_id VARCHAR(255) NOT NULL,
      period_kind VARCHAR(5) NOT NULL CHECK (period_kind IN ('day', 'month')),
      period_start TIMESTAMPTZ NOT NULL,
      request_count BIGINT NOT NULL DEFAULT 0 CHECK (request_count >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, service_id, period_kind, period_start)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_api_quota_counters_updated
    ON api_quota_counters (updated_at)
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS api_quota_reservations (
      reservation_id VARCHAR(255) PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL,
      service_id VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMPTZ NOT NULL,
      released_at TIMESTAMPTZ
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_api_quota_reservations_active
    ON api_quota_reservations (user_id, service_id, expires_at)
    WHERE released_at IS NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_api_quota_reservations_expiry
    ON api_quota_reservations (expires_at)
    WHERE released_at IS NULL
  `);
  await client.query("COMMIT");
  console.log("Security schema migration completed successfully.");
} catch (error) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original migration error.
  }
  console.error(
    "Security schema migration failed:",
    error instanceof Error ? error.message : error
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
