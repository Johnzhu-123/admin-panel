import { randomUUID } from "node:crypto";
import { createClient } from "@vercel/postgres";

export type QuotaLimits = {
  dailyRequests: number;
  monthlyRequests: number;
  concurrentRequests: number;
};

export type AcquireQuotaInput = {
  userId: string;
  serviceId: string;
  limits: QuotaLimits;
  reservationTtlMs?: number;
  now?: Date;
  reservationId?: string;
};

export type AcquireQuotaResult =
  | {
      acquired: true;
      reservationId: string;
      expiresAt: Date;
      usage: { daily: number; monthly: number; concurrent: number };
    }
  | {
      acquired: false;
      reason: "daily_limit" | "monthly_limit" | "concurrent_limit" | "database_error";
    };

export type ReleaseQuotaResult =
  | { released: true; changed: boolean }
  | { released: false; reason: "database_error" };

type QueryResult<Row = Record<string, unknown>> = { rows: Row[]; rowCount?: number | null };

export type QuotaQueryClient = {
  connect(): Promise<void>;
  query<Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
  end(): Promise<void>;
};

export type QuotaServiceOptions = {
  createClient?: () => QuotaQueryClient;
  logError?: (message: string, error: unknown) => void;
};

const DEFAULT_RESERVATION_TTL_MS = 5 * 60 * 1000;
const MAX_RESERVATION_TTL_MS = 60 * 60 * 1000;

function periodStarts(now: Date): { daily: string; monthly: string } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    daily: new Date(Date.UTC(year, month, now.getUTCDate())).toISOString(),
    monthly: new Date(Date.UTC(year, month, 1)).toISOString(),
  };
}

function normalizeLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function requireIdentifier(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 255) {
    throw new TypeError(`${name} must contain 1-255 characters`);
  }
  return normalized;
}

function asCount(value: unknown): number {
  const count = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Database returned an invalid quota count");
  }
  return count;
}

export class PostgresQuotaService {
  private readonly makeClient: () => QuotaQueryClient;
  private readonly logError: (message: string, error: unknown) => void;

  constructor(options: QuotaServiceOptions = {}) {
    this.makeClient = options.createClient ?? (() => createClient() as unknown as QuotaQueryClient);
    this.logError = options.logError ?? ((message, error) => console.error(message, error));
  }

  async acquire(input: AcquireQuotaInput): Promise<AcquireQuotaResult> {
    const userId = requireIdentifier(input.userId, "userId");
    const serviceId = requireIdentifier(input.serviceId, "serviceId");
    const dailyLimit = normalizeLimit(input.limits.dailyRequests, "dailyRequests");
    const monthlyLimit = normalizeLimit(input.limits.monthlyRequests, "monthlyRequests");
    const concurrentLimit = normalizeLimit(input.limits.concurrentRequests, "concurrentRequests");
    const ttlMs = input.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_RESERVATION_TTL_MS) {
      throw new TypeError(`reservationTtlMs must be between 1 and ${MAX_RESERVATION_TTL_MS}`);
    }

    const now = input.now ? new Date(input.now) : new Date();
    if (Number.isNaN(now.getTime())) throw new TypeError("now must be a valid date");
    const expiresAt = new Date(now.getTime() + ttlMs);
    const reservationId = input.reservationId ?? randomUUID();
    requireIdentifier(reservationId, "reservationId");
    const starts = periodStarts(now);
    const client = this.makeClient();

    try {
      await client.connect();
      await client.query("BEGIN");
      // Serialize quota decisions for the same user/service without locking unrelated users.
      await client.query(
        "/* quota:lock */ SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${userId}\u0000${serviceId}`]
      );
      await client.query(
        `/* quota:expire */
         UPDATE api_quota_reservations
            SET released_at = $3
          WHERE user_id = $1 AND service_id = $2
            AND released_at IS NULL AND expires_at <= $3`,
        [userId, serviceId, now]
      );

      const usageResult = await client.query<{
        daily_count: string | number;
        monthly_count: string | number;
        concurrent_count: string | number;
      }>(
        `/* quota:read */
         SELECT
           COALESCE((SELECT request_count FROM api_quota_counters
             WHERE user_id = $1 AND service_id = $2 AND period_kind = 'day' AND period_start = $3), 0) AS daily_count,
           COALESCE((SELECT request_count FROM api_quota_counters
             WHERE user_id = $1 AND service_id = $2 AND period_kind = 'month' AND period_start = $4), 0) AS monthly_count,
           (SELECT COUNT(*) FROM api_quota_reservations
             WHERE user_id = $1 AND service_id = $2 AND released_at IS NULL AND expires_at > $5) AS concurrent_count`,
        [userId, serviceId, starts.daily, starts.monthly, now]
      );
      const row = usageResult.rows[0];
      if (!row) throw new Error("Database did not return quota usage");
      const daily = asCount(row.daily_count);
      const monthly = asCount(row.monthly_count);
      const concurrent = asCount(row.concurrent_count);

      // A zero limit retains the legacy meaning of "unlimited".
      if (dailyLimit > 0 && daily >= dailyLimit) {
        await client.query("ROLLBACK");
        return { acquired: false, reason: "daily_limit" };
      }
      if (monthlyLimit > 0 && monthly >= monthlyLimit) {
        await client.query("ROLLBACK");
        return { acquired: false, reason: "monthly_limit" };
      }
      if (concurrentLimit > 0 && concurrent >= concurrentLimit) {
        await client.query("ROLLBACK");
        return { acquired: false, reason: "concurrent_limit" };
      }

      await client.query(
        `/* quota:increment */
         INSERT INTO api_quota_counters
           (user_id, service_id, period_kind, period_start, request_count, updated_at)
         VALUES ($1, $2, 'day', $3, 1, $5), ($1, $2, 'month', $4, 1, $5)
         ON CONFLICT (user_id, service_id, period_kind, period_start)
         DO UPDATE SET request_count = api_quota_counters.request_count + 1, updated_at = EXCLUDED.updated_at`,
        [userId, serviceId, starts.daily, starts.monthly, now]
      );
      await client.query(
        `/* quota:reserve */
         INSERT INTO api_quota_reservations
           (reservation_id, user_id, service_id, created_at, expires_at, released_at)
         VALUES ($1, $2, $3, $4, $5, NULL)`,
        [reservationId, userId, serviceId, now, expiresAt]
      );
      await client.query("COMMIT");
      return {
        acquired: true,
        reservationId,
        expiresAt,
        usage: { daily: daily + 1, monthly: monthly + 1, concurrent: concurrent + 1 },
      };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve and report the original database failure.
      }
      this.logError("Quota acquisition failed closed", error);
      return { acquired: false, reason: "database_error" };
    } finally {
      try {
        await client.end();
      } catch (error) {
        this.logError("Failed to close quota database client", error);
      }
    }
  }

  async release(reservationIdInput: string): Promise<ReleaseQuotaResult> {
    const reservationId = requireIdentifier(reservationIdInput, "reservationId");
    const client = this.makeClient();
    try {
      await client.connect();
      const result = await client.query(
        `/* quota:release */
         UPDATE api_quota_reservations
            SET released_at = CURRENT_TIMESTAMP
          WHERE reservation_id = $1 AND released_at IS NULL`,
        [reservationId]
      );
      return { released: true, changed: (result.rowCount ?? 0) > 0 };
    } catch (error) {
      this.logError("Quota release failed closed", error);
      return { released: false, reason: "database_error" };
    } finally {
      try {
        await client.end();
      } catch (error) {
        this.logError("Failed to close quota database client", error);
      }
    }
  }
}

export const quotaService = new PostgresQuotaService();
