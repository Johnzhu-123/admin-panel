import {
  PostgresQuotaService,
  type QuotaQueryClient,
} from "../quota-service";

type Reservation = { expiresAt: Date; released: boolean };

class FakeQuotaDatabase {
  counters = new Map<string, number>();
  reservations = new Map<string, Reservation>();
  failOn: string | null = null;
  private tail = Promise.resolve();

  createClient = (): QuotaQueryClient => {
    let unlock: (() => void) | undefined;
    return {
      connect: async () => undefined,
      end: async () => undefined,
      query: async <Row>(text: string, values: unknown[] = []) => {
        if (this.failOn && text.includes(this.failOn)) throw new Error("database unavailable");
        if (text === "BEGIN") return { rows: [] as Row[] };
        if (text.includes("quota:lock")) {
          const previous = this.tail;
          this.tail = new Promise<void>((resolve) => { unlock = resolve; });
          await previous;
          return { rows: [] as Row[] };
        }
        if (text === "COMMIT" || text === "ROLLBACK") {
          unlock?.();
          unlock = undefined;
          return { rows: [] as Row[] };
        }
        if (text.includes("quota:expire")) {
          const now = values[2] as Date;
          let count = 0;
          for (const reservation of this.reservations.values()) {
            if (!reservation.released && reservation.expiresAt <= now) {
              reservation.released = true;
              count += 1;
            }
          }
          return { rows: [] as Row[], rowCount: count };
        }
        if (text.includes("quota:read")) {
          const [userId, serviceId, dailyStart, monthlyStart, now] = values as [string, string, string, string, Date];
          const prefix = `${userId}:${serviceId}`;
          const concurrent = [...this.reservations.values()].filter(
            (reservation) => !reservation.released && reservation.expiresAt > now
          ).length;
          return {
            rows: [{
              daily_count: this.counters.get(`${prefix}:day:${dailyStart}`) ?? 0,
              monthly_count: this.counters.get(`${prefix}:month:${monthlyStart}`) ?? 0,
              concurrent_count: concurrent,
            } as Row],
          };
        }
        if (text.includes("quota:increment")) {
          const [userId, serviceId, dailyStart, monthlyStart] = values as string[];
          const prefix = `${userId}:${serviceId}`;
          for (const key of [`${prefix}:day:${dailyStart}`, `${prefix}:month:${monthlyStart}`]) {
            this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
          }
          return { rows: [] as Row[], rowCount: 2 };
        }
        if (text.includes("quota:reserve")) {
          this.reservations.set(values[0] as string, { expiresAt: values[4] as Date, released: false });
          return { rows: [] as Row[], rowCount: 1 };
        }
        if (text.includes("quota:release")) {
          const reservation = this.reservations.get(values[0] as string);
          const changed = Boolean(reservation && !reservation.released);
          if (reservation) reservation.released = true;
          return { rows: [] as Row[], rowCount: changed ? 1 : 0 };
        }
        throw new Error(`Unexpected query: ${text}`);
      },
    };
  };
}

const baseInput = {
  userId: "user_1",
  serviceId: "image",
  limits: { dailyRequests: 10, monthlyRequests: 100, concurrentRequests: 2 },
  now: new Date("2026-07-10T10:00:00.000Z"),
};

function setup() {
  const database = new FakeQuotaDatabase();
  const errors: unknown[] = [];
  const service = new PostgresQuotaService({
    createClient: database.createClient,
    logError: (_message, error) => errors.push(error),
  });
  return { database, service, errors };
}

describe("PostgresQuotaService", () => {
  test("counts every acquired dispatch in daily and monthly usage", async () => {
    const { service } = setup();
    const first = await service.acquire({ ...baseInput, reservationId: "r1" });
    expect(first).toMatchObject({ acquired: true, usage: { daily: 1, monthly: 1, concurrent: 1 } });
    await service.release("r1");
    const second = await service.acquire({ ...baseInput, reservationId: "r2" });
    expect(second).toMatchObject({ acquired: true, usage: { daily: 2, monthly: 2, concurrent: 1 } });
  });

  test.each([
    ["daily", { dailyRequests: 1, monthlyRequests: 10, concurrentRequests: 10 }, "daily_limit"],
    ["monthly", { dailyRequests: 10, monthlyRequests: 1, concurrentRequests: 10 }, "monthly_limit"],
  ])("enforces the %s request limit", async (_name, limits, reason) => {
    const { service } = setup();
    await service.acquire({ ...baseInput, limits, reservationId: "r1" });
    await service.release("r1");
    await expect(service.acquire({ ...baseInput, limits, reservationId: "r2" }))
      .resolves.toEqual({ acquired: false, reason });
  });

  test("enforces concurrent reservations and permits work after release", async () => {
    const { service } = setup();
    const limits = { dailyRequests: 10, monthlyRequests: 10, concurrentRequests: 1 };
    expect((await service.acquire({ ...baseInput, limits, reservationId: "r1" })).acquired).toBe(true);
    await expect(service.acquire({ ...baseInput, limits, reservationId: "r2" }))
      .resolves.toEqual({ acquired: false, reason: "concurrent_limit" });
    await expect(service.release("r1")).resolves.toEqual({ released: true, changed: true });
    expect((await service.acquire({ ...baseInput, limits, reservationId: "r3" })).acquired).toBe(true);
  });

  test("expires stale reservations before checking concurrency", async () => {
    const { service } = setup();
    const limits = { dailyRequests: 10, monthlyRequests: 10, concurrentRequests: 1 };
    await service.acquire({ ...baseInput, limits, reservationTtlMs: 1_000, reservationId: "old" });
    const later = new Date(baseInput.now.getTime() + 1_001);
    const result = await service.acquire({ ...baseInput, limits, now: later, reservationId: "new" });
    expect(result).toMatchObject({ acquired: true, usage: { concurrent: 1 } });
  });

  test("release is idempotent", async () => {
    const { service } = setup();
    await service.acquire({ ...baseInput, reservationId: "r1" });
    await expect(service.release("r1")).resolves.toEqual({ released: true, changed: true });
    await expect(service.release("r1")).resolves.toEqual({ released: true, changed: false });
  });

  test("fails closed when acquisition or release database operations fail", async () => {
    const { database, service, errors } = setup();
    database.failOn = "quota:read";
    await expect(service.acquire({ ...baseInput, reservationId: "r1" }))
      .resolves.toEqual({ acquired: false, reason: "database_error" });
    database.failOn = "quota:release";
    await expect(service.release("r1"))
      .resolves.toEqual({ released: false, reason: "database_error" });
    expect(errors).toHaveLength(2);
  });

  test("serializes simultaneous acquisitions so the concurrency limit cannot be oversubscribed", async () => {
    const { service } = setup();
    const limits = { dailyRequests: 10, monthlyRequests: 10, concurrentRequests: 1 };
    const results = await Promise.all([
      service.acquire({ ...baseInput, limits, reservationId: "race-a" }),
      service.acquire({ ...baseInput, limits, reservationId: "race-b" }),
    ]);
    expect(results.filter((result) => result.acquired)).toHaveLength(1);
    expect(results.filter((result) => !result.acquired)).toEqual([
      { acquired: false, reason: "concurrent_limit" },
    ]);
  });
});
