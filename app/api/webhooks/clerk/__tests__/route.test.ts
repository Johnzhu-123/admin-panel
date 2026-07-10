/** @jest-environment node */

const verify = jest.fn();
jest.mock("svix", () => ({
  Webhook: jest.fn().mockImplementation(() => ({ verify })),
}));

import { POST } from "../route";

describe("Clerk webhook", () => {
  beforeEach(() => {
    verify.mockReset();
    process.env.CLERK_WEBHOOK_SECRET = "whsec_test";
  });

  it("verifies the exact raw request body", async () => {
    const raw = '{\n  "type": "user.created", "data": {"id":"user_1"}\n}';
    const response = await POST(new Request("https://admin.example/api/webhooks/clerk", {
      method: "POST",
      headers: {
        "svix-id": "msg_1",
        "svix-timestamp": "123",
        "svix-signature": "v1,test",
      },
      body: raw,
    }));
    expect(response.status).toBe(200);
    expect(verify).toHaveBeenCalledWith(raw, expect.any(Object));
  });

  it("fails closed when the webhook secret is missing", async () => {
    delete process.env.CLERK_WEBHOOK_SECRET;
    const response = await POST(new Request("https://admin.example/api/webhooks/clerk", {
      method: "POST",
    }));
    expect(response.status).toBe(503);
  });
});
