/** @jest-environment node */

import { sql } from "@vercel/postgres";
import { quotaService } from "../quota-service";
import { BuiltInQuotaError, runWithBuiltInQuota } from "../legacy-quota";

jest.mock("@vercel/postgres", () => ({ sql: jest.fn() }));
jest.mock("../quota-service", () => ({
  quotaService: { acquire: jest.fn(), release: jest.fn() },
}));

const mockSql = sql as jest.MockedFunction<typeof sql>;
const mockAcquire = quotaService.acquire as jest.MockedFunction<
  typeof quotaService.acquire
>;
const mockRelease = quotaService.release as jest.MockedFunction<
  typeof quotaService.release
>;

describe("legacy built-in quota wrapper", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSql.mockResolvedValue({
      rows: [
        {
          status: "active",
          can_use_built_in_services: true,
          daily_requests: 10,
          monthly_requests: 100,
          concurrent_requests: 2,
        },
      ],
      rowCount: 1,
    } as never);
    mockAcquire.mockResolvedValue({
      acquired: true,
      reservationId: "r1",
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      usage: { daily: 1, monthly: 1, concurrent: 1 },
    });
    mockRelease.mockResolvedValue({ released: true, changed: true });
  });

  it("releases buffered dispatches before returning", async () => {
    await expect(
      runWithBuiltInQuota({
        userId: "user@example.com",
        serviceId: "built-in-text-plan",
        dispatch: async () => ({ ok: true }),
      })
    ).resolves.toEqual({ ok: true });
    expect(mockRelease).toHaveBeenCalledWith("r1");
  });

  it("keeps a reservation until a streamed response completes", async () => {
    const response = await runWithBuiltInQuota({
      userId: "user@example.com",
      serviceId: "built-in-video-default",
      dispatch: async () => new Response("streamed"),
    });
    expect(mockRelease).not.toHaveBeenCalled();
    await expect(response.text()).resolves.toBe("streamed");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockRelease).toHaveBeenCalledWith("r1");
  });

  it("does not finish consuming a stream until the reservation release completes", async () => {
    let finishRelease!: (value: { released: true; changed: true }) => void;
    mockRelease.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRelease = resolve;
        })
    );
    const response = await runWithBuiltInQuota({
      userId: "user@example.com",
      serviceId: "built-in-text-summary",
      dispatch: async () => new Response("done"),
    });
    let settled = false;
    const body = response.text().then((value) => {
      settled = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    finishRelease({ released: true, changed: true });
    await expect(body).resolves.toBe("done");
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("releases exactly once when the downstream cancels a stream", async () => {
    const response = await runWithBuiltInQuota({
      userId: "user@example.com",
      serviceId: "built-in-video-default",
      dispatch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
          })
        ),
    });
    await response.body?.cancel("client disconnected");
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledWith("r1");
  });

  it("fails closed on authorization or quota database errors", async () => {
    mockSql.mockRejectedValueOnce(new Error("db down"));
    await expect(
      runWithBuiltInQuota({ userId: "u", serviceId: "s", dispatch: async () => true })
    ).rejects.toMatchObject({ status: 503 });

    mockAcquire.mockResolvedValueOnce({ acquired: false, reason: "database_error" });
    await expect(
      runWithBuiltInQuota({ userId: "u", serviceId: "s", dispatch: async () => true })
    ).rejects.toBeInstanceOf(BuiltInQuotaError);
  });
});
