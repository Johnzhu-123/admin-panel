import { sql } from "@vercel/postgres";
import { quotaService } from "@/lib/built-in-api-service/quota-service";

export class BuiltInQuotaError extends Error {
  constructor(
    message: string,
    public readonly status: 403 | 429 | 503
  ) {
    super(message);
    this.name = "BuiltInQuotaError";
  }
}

type QuotaLimitRow = {
  status?: string;
  can_use_built_in_services?: boolean;
  daily_requests?: number | string | null;
  monthly_requests?: number | string | null;
  concurrent_requests?: number | string | null;
};

const quotaNumber = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
};

async function loadQuotaLimits(userId: string) {
  let rows: QuotaLimitRow[];
  try {
    const result = await sql<QuotaLimitRow>`
      SELECT status, can_use_built_in_services,
             daily_requests, monthly_requests, concurrent_requests
      FROM authorized_users
      WHERE LOWER(user_id) = LOWER(${userId})
         OR LOWER(email) = LOWER(${userId})
      LIMIT 1
    `;
    rows = result.rows;
  } catch (error) {
    console.error("[legacy-quota] authorization storage unavailable", error);
    throw new BuiltInQuotaError("配额服务暂不可用", 503);
  }
  const row = rows[0];
  if (!row || row.status !== "active" || row.can_use_built_in_services !== true) {
    throw new BuiltInQuotaError("用户未被授权使用内置服务", 403);
  }
  return {
    dailyRequests: quotaNumber(row.daily_requests),
    monthlyRequests: quotaNumber(row.monthly_requests),
    concurrentRequests: quotaNumber(row.concurrent_requests),
  };
}

async function releaseOrThrow(reservationId: string) {
  const released = await quotaService.release(reservationId);
  if (!released.released) {
    throw new BuiltInQuotaError("配额服务暂不可用", 503);
  }
}

export function attachQuotaReleaseToResponse(
  response: Response,
  reservationId: string,
  logPrefix = "legacy-quota"
) {
  if (!response.body) {
    return releaseOrThrow(reservationId).then(() => response);
  }
  const reader = response.body.getReader();
  let releasePromise: Promise<boolean> | null = null;
  const releaseOnce = () => {
    if (!releasePromise) {
      releasePromise = (async () => {
        try {
          const released = await quotaService.release(reservationId);
          if (!released.released) {
            console.error(`[${logPrefix}] quota reservation release failed`);
            return false;
          }
          return true;
        } catch (error) {
          console.error(`[${logPrefix}] quota reservation release threw`, error);
          return false;
        }
      })();
    }
    return releasePromise;
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          await releaseOnce();
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        await releaseOnce();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await releaseOnce();
      }
    },
  });
  return Promise.resolve(
    new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  );
}

export async function runWithBuiltInQuota<T>(input: {
  userId: string;
  serviceId: string;
  dispatch: () => Promise<T>;
  reservationTtlMs?: number;
}): Promise<T> {
  const limits = await loadQuotaLimits(input.userId);
  const acquired = await quotaService.acquire({
    userId: input.userId,
    serviceId: input.serviceId,
    limits,
    reservationTtlMs: input.reservationTtlMs,
  });
  if (acquired.acquired === false) {
    throw new BuiltInQuotaError(
      acquired.reason === "database_error" ? "配额服务暂不可用" : "请求配额已用尽",
      acquired.reason === "database_error" ? 503 : 429
    );
  }

  try {
    const result = await input.dispatch();
    if (result instanceof Response) {
      return (await attachQuotaReleaseToResponse(result, acquired.reservationId)) as T;
    }
    await releaseOrThrow(acquired.reservationId);
    return result;
  } catch (error) {
    const released = await quotaService.release(acquired.reservationId);
    if (!released.released) {
      throw new BuiltInQuotaError("配额服务暂不可用", 503);
    }
    throw error;
  }
}
