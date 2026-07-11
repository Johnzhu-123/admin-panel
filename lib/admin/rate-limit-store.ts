import { createHash } from "crypto";
import { isIP } from "net";
import { sql } from "@vercel/postgres";

const DEFAULT_CLIENT_LIMIT = 5;
const DEFAULT_GLOBAL_LIMIT = 100;
const DEFAULT_CLIENT_WINDOW_SECONDS = 15 * 60;
const DEFAULT_GLOBAL_WINDOW_SECONDS = 15 * 60;
const MAX_PERSISTED_CLIENTS = 10_000;

type RateLimitRow = {
  allowed: boolean;
  retry_after_seconds: number | string | null;
};

export type AdminLoginRateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = Number.parseInt(raw || "", 10);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

function normalizeIp(raw: string | null): string | null {
  if (!raw) return null;
  const candidate = raw.trim();
  if (isIP(candidate)) return candidate;
  const bracketed = candidate.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed && isIP(bracketed[1])) return bracketed[1];
  const ipv4WithPort = candidate.match(/^([^:]+):\d+$/);
  if (ipv4WithPort && isIP(ipv4WithPort[1]) === 4) return ipv4WithPort[1];
  return null;
}

function firstValidAddress(raw: string | null): string | null {
  if (!raw) return null;
  for (const part of raw.split(",")) {
    const normalized = normalizeIp(part);
    if (normalized) return normalized;
  }
  return null;
}

function nearestValidAddress(raw: string | null): string | null {
  if (!raw) return null;
  const parts = raw.split(",");
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const normalized = normalizeIp(parts[index]);
    if (normalized) return normalized;
  }
  return null;
}

export function resolveAdminClientIdentifier(headers: Headers): string {
  if (process.env.VERCEL === "1") {
    const vercelAddress = firstValidAddress(
      headers.get("x-vercel-forwarded-for")
    );
    if (vercelAddress) return vercelAddress;
  }

  if (process.env.ADMIN_TRUST_PROXY_HEADERS === "1") {
    const realIp = normalizeIp(headers.get("x-real-ip"));
    if (realIp) return realIp;
    const forwarded = nearestValidAddress(headers.get("x-forwarded-for"));
    if (forwarded) return forwarded;
  }

  return "untrusted-client";
}

export function hashAdminClientIdentifier(identifier: string): string {
  return createHash("sha256").update(identifier, "utf8").digest("hex");
}

export async function consumeAdminLoginAttempt(
  clientIdentifier: string,
  now = new Date()
): Promise<AdminLoginRateLimitResult> {
  const clientHash = hashAdminClientIdentifier(clientIdentifier);
  const globalHash = hashAdminClientIdentifier("global");
  const clientLimit = boundedInteger(
    process.env.ADMIN_LOGIN_CLIENT_LIMIT,
    DEFAULT_CLIENT_LIMIT,
    1,
    100
  );
  const globalLimit = boundedInteger(
    process.env.ADMIN_LOGIN_GLOBAL_LIMIT,
    DEFAULT_GLOBAL_LIMIT,
    clientLimit,
    10_000
  );
  const clientWindowSeconds = boundedInteger(
    process.env.ADMIN_LOGIN_CLIENT_WINDOW_SECONDS,
    DEFAULT_CLIENT_WINDOW_SECONDS,
    60,
    86_400
  );
  const globalWindowSeconds = boundedInteger(
    process.env.ADMIN_LOGIN_GLOBAL_WINDOW_SECONDS,
    DEFAULT_GLOBAL_WINDOW_SECONDS,
    60,
    86_400
  );

  const { rows } = await sql<RateLimitRow>`
    WITH parameters AS (
      SELECT
        ${now.toISOString()}::timestamptz AS now_at,
        ${clientHash}::text AS client_hash,
        ${globalHash}::text AS global_hash,
        ${clientLimit}::integer AS client_limit,
        ${globalLimit}::integer AS global_limit,
        ${clientWindowSeconds}::integer AS client_window_seconds,
        ${globalWindowSeconds}::integer AS global_window_seconds
    ),
    pruned AS (
      DELETE FROM admin_login_rate_limits AS stored
      USING parameters
      WHERE stored.identifier_hash NOT IN (
        parameters.client_hash,
        parameters.global_hash
      )
        AND (
          stored.window_expires_at < CURRENT_TIMESTAMP - INTERVAL '1 day'
          OR (
            stored.scope = 'client'
            AND stored.identifier_hash IN (
              SELECT identifier_hash
              FROM admin_login_rate_limits
              WHERE scope = 'client'
              ORDER BY updated_at DESC
              OFFSET ${MAX_PERSISTED_CLIENTS - 1}
            )
          )
        )
    ),
    attempts AS (
      INSERT INTO admin_login_rate_limits (
        scope,
        identifier_hash,
        window_started_at,
        window_expires_at,
        attempt_count,
        updated_at
      )
      SELECT
        'global',
        global_hash,
        now_at,
        now_at + make_interval(secs => global_window_seconds),
        1,
        now_at
      FROM parameters
      UNION ALL
      SELECT
        'client',
        client_hash,
        now_at,
        now_at + make_interval(secs => client_window_seconds),
        1,
        now_at
      FROM parameters
      ON CONFLICT (scope, identifier_hash)
      DO UPDATE SET
        window_started_at = CASE
          WHEN admin_login_rate_limits.window_expires_at <= EXCLUDED.window_started_at
          THEN EXCLUDED.window_started_at
          ELSE admin_login_rate_limits.window_started_at
        END,
        window_expires_at = CASE
          WHEN admin_login_rate_limits.window_expires_at <= EXCLUDED.window_started_at
          THEN EXCLUDED.window_expires_at
          ELSE admin_login_rate_limits.window_expires_at
        END,
        attempt_count = CASE
          WHEN admin_login_rate_limits.window_expires_at <= EXCLUDED.window_started_at
          THEN 1
          ELSE admin_login_rate_limits.attempt_count + 1
        END,
        updated_at = EXCLUDED.updated_at
      RETURNING scope, attempt_count, window_expires_at
    )
    SELECT
      bool_and(
        CASE
          WHEN attempts.scope = 'client'
          THEN attempts.attempt_count <= parameters.client_limit
          ELSE attempts.attempt_count <= parameters.global_limit
        END
      ) AS allowed,
      COALESCE(
        CEIL(EXTRACT(EPOCH FROM (
          MAX(attempts.window_expires_at) FILTER (
            WHERE CASE
              WHEN attempts.scope = 'client'
              THEN attempts.attempt_count > parameters.client_limit
              ELSE attempts.attempt_count > parameters.global_limit
            END
          ) - parameters.now_at
        ))),
        0
      )::integer AS retry_after_seconds
    FROM attempts
    CROSS JOIN parameters
    GROUP BY parameters.now_at
  `;

  const row = rows[0];
  return {
    allowed: row?.allowed === true,
    retryAfterSeconds: Math.max(
      0,
      Number.parseInt(String(row?.retry_after_seconds ?? 0), 10) || 0
    ),
  };
}

export async function clearAdminClientLoginAttempts(
  clientIdentifier: string
): Promise<void> {
  const clientHash = hashAdminClientIdentifier(clientIdentifier);
  await sql`
    DELETE FROM admin_login_rate_limits
    WHERE scope = 'client'
      AND identifier_hash = ${clientHash}
  `;
}
