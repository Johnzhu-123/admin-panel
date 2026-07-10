/** @jest-environment node */

import { serverFetchWithRetry } from "../server-fetch-with-retry";

describe("serverFetchWithRetry custom request boundary", () => {
  it("invokes the custom request wrapper for every physical retry", async () => {
    const request = jest
      .fn<Promise<Response>, [string, RequestInit]>()
      .mockResolvedValueOnce(new Response("retry", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const response = await serverFetchWithRetry(
      "https://catalog.example/v1/chat/completions",
      { method: "POST", body: "{}" },
      {
        retries: 2,
        retryDelayMs: 0,
        request,
      }
    );

    expect(request).toHaveBeenCalledTimes(2);
    await expect(response.text()).resolves.toBe("ok");
  });
});
