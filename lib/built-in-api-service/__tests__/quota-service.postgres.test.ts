import { createClient } from "@vercel/postgres";

import { PostgresQuotaService } from "../quota-service";

const runWithPostgres = process.env.POSTGRES_URL ? describe : describe.skip;

runWithPostgres("PostgreSQL quota concurrency", () => {
  jest.setTimeout(120_000);

  test("serializes 100 concurrent reservations and enforces the active limit", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const userId = `ci-user-${suffix}`;
    const serviceId = `ci-service-${suffix}`;
    const service = new PostgresQuotaService({ logError: () => undefined });

    const results = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        service.acquire({
          userId,
          serviceId,
          reservationId: `ci-reservation-${suffix}-${index}`,
          limits: { dailyRequests: 100, monthlyRequests: 100, concurrentRequests: 10 },
        })
      )
    );

    const acquired = results.filter((result) => result.acquired);
    const rejected = results.filter((result) => !result.acquired);
    expect(acquired).toHaveLength(10);
    expect(rejected).toHaveLength(90);
    expect(rejected.every((result) => result.acquired === false && result.reason === "concurrent_limit")).toBe(true);

    const client = createClient();
    await client.connect();
    try {
      const counters = await client.query(
        `SELECT period_kind, request_count FROM api_quota_counters
          WHERE user_id = $1 AND service_id = $2 ORDER BY period_kind`,
        [userId, serviceId]
      );
      expect(counters.rows).toEqual([
        expect.objectContaining({ period_kind: "day", request_count: "10" }),
        expect.objectContaining({ period_kind: "month", request_count: "10" }),
      ]);
    } finally {
      await client.end();
    }

    await Promise.all(
      acquired.map((result) => result.acquired && service.release(result.reservationId))
    );

    const verificationClient = createClient();
    await verificationClient.connect();
    try {
      const active = await verificationClient.query(
        `SELECT COUNT(*) AS count FROM api_quota_reservations
          WHERE user_id = $1 AND service_id = $2 AND released_at IS NULL`,
        [userId, serviceId]
      );
      expect(active.rows[0]?.count).toBe("0");
    } finally {
      await verificationClient.query(
        "DELETE FROM api_quota_reservations WHERE user_id = $1 AND service_id = $2",
        [userId, serviceId]
      );
      await verificationClient.query(
        "DELETE FROM api_quota_counters WHERE user_id = $1 AND service_id = $2",
        [userId, serviceId]
      );
      await verificationClient.end();
    }
  });
});
