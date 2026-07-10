/** @jest-environment node */

jest.unmock("@vercel/postgres");

import {
  createClient,
  createPool,
  type VercelPool,
  type VercelPoolClient,
} from "@vercel/postgres";
import { Client } from "pg";

import {
  PostgresQuotaService,
  type QuotaQueryClient,
} from "../quota-service";

const runWithPostgres = process.env.POSTGRES_URL ? describe : describe.skip;

function createPoolBackedClient(pool: VercelPool): QuotaQueryClient {
  let client: VercelPoolClient | null = null;

  return {
    async connect() {
      client = await pool.connect();
    },
    async query<Row = Record<string, unknown>>(text: string, values?: unknown[]) {
      if (!client) throw new Error("PostgreSQL pool client is not connected");
      return client.query(text, values) as Promise<{
        rows: Row[];
        rowCount?: number | null;
      }>;
    },
    async end() {
      client?.release();
      client = null;
    },
  };
}

function createNodePostgresClient(): QuotaQueryClient {
  const client = new Client({
    connectionString:
      process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL,
  });
  return {
    async connect() {
      await client.connect();
    },
    async query<Row = Record<string, unknown>>(text: string, values?: unknown[]) {
      const result = await client.query(text, values);
      return {
        rows: result.rows as Row[],
        rowCount: result.rowCount,
      };
    },
    async end() {
      await client.end();
    },
  };
}

runWithPostgres("PostgreSQL quota concurrency", () => {
  test(
    "serializes 100 concurrent reservations and enforces the active limit",
    async () => {
      const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const userId = `ci-user-${suffix}`;
      const serviceId = `ci-service-${suffix}`;
      const requestCount = Number(process.env.POSTGRES_TEST_REQUEST_COUNT || 100);
      if (!Number.isSafeInteger(requestCount) || requestCount < 1 || requestCount > 100) {
        throw new Error("POSTGRES_TEST_REQUEST_COUNT must be an integer from 1 to 100");
      }
      const pool =
        process.env.POSTGRES_TEST_USE_POOL === "1"
          ? createPool({ connectionString: process.env.POSTGRES_URL, max: 20 })
          : null;
      const makeClient = (): QuotaQueryClient =>
        pool
          ? createPoolBackedClient(pool)
          : process.env.POSTGRES_USE_NODE_PG === "1"
            ? createNodePostgresClient()
            : (createClient() as unknown as QuotaQueryClient);
      const databaseErrors: Array<{ message: string; error: unknown }> = [];
      const service = new PostgresQuotaService({
        createClient: makeClient,
        logError: (message, error) => databaseErrors.push({ message, error }),
      });

      try {
        const results = await Promise.all(
          Array.from({ length: requestCount }, (_, index) =>
            service.acquire({
              userId,
              serviceId,
              reservationId: `ci-reservation-${suffix}-${index}`,
              limits: {
                dailyRequests: requestCount,
                monthlyRequests: requestCount,
                concurrentRequests: 10,
              },
            })
          )
        );

        const acquired = results.filter((result) => result.acquired);
        const rejected = results.filter((result) => !result.acquired);
        expect(databaseErrors).toEqual([]);
        const expectedAcquired = Math.min(10, requestCount);
        expect(acquired).toHaveLength(expectedAcquired);
        expect(rejected).toHaveLength(requestCount - expectedAcquired);
        expect(
          rejected.every(
            (result) =>
              result.acquired === false &&
              result.reason === "concurrent_limit"
          )
        ).toBe(true);

        const client = makeClient();
        await client.connect();
        try {
          const counters = await client.query<{
            period_kind: string;
            request_count: string;
          }>(
            `SELECT period_kind, request_count FROM api_quota_counters
              WHERE user_id = $1 AND service_id = $2 ORDER BY period_kind`,
            [userId, serviceId]
          );
          expect(counters.rows).toEqual([
            expect.objectContaining({
              period_kind: "day",
              request_count: String(expectedAcquired),
            }),
            expect.objectContaining({
              period_kind: "month",
              request_count: String(expectedAcquired),
            }),
          ]);
        } finally {
          await client.end();
        }

        await Promise.all(
          acquired.map(
            (result) => result.acquired && service.release(result.reservationId)
          )
        );

        const verificationClient = makeClient();
        await verificationClient.connect();
        try {
          const active = await verificationClient.query<{ count: string }>(
            `SELECT COUNT(*) AS count FROM api_quota_reservations
              WHERE user_id = $1 AND service_id = $2 AND released_at IS NULL`,
            [userId, serviceId]
          );
          expect(active.rows[0]?.count).toBe("0");
        } finally {
          await verificationClient.end();
        }
      } finally {
        const cleanupClient = makeClient();
        await cleanupClient.connect();
        try {
          await cleanupClient.query(
            "DELETE FROM api_quota_reservations WHERE user_id = $1 AND service_id = $2",
            [userId, serviceId]
          );
          await cleanupClient.query(
            "DELETE FROM api_quota_counters WHERE user_id = $1 AND service_id = $2",
            [userId, serviceId]
          );
        } finally {
          await cleanupClient.end();
          await pool?.end();
        }
      }
    },
    300_000
  );
});
