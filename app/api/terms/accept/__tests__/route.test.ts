/** @jest-environment node */

const currentUser = jest.fn();
const recordTermsAcceptance = jest.fn();
const getUserTermsAcceptance = jest.fn();

jest.mock("@clerk/nextjs/server", () => ({ currentUser: () => currentUser() }));
jest.mock("@/lib/built-in-api-service/db", () => ({
  recordTermsAcceptance: (...args: unknown[]) => recordTermsAcceptance(...args),
  getUserTermsAcceptance: (...args: unknown[]) => getUserTermsAcceptance(...args),
}));

import { POST } from "../route";

describe("terms acceptance", () => {
  beforeEach(() => {
    currentUser.mockReset();
    recordTermsAcceptance.mockReset();
  });

  it("rejects pre-signup or anonymous acceptance", async () => {
    currentUser.mockResolvedValue(null);
    const response = await POST(new Request("https://admin.example/api/terms/accept", {
      method: "POST",
      body: JSON.stringify({ termsVersion: "1.0", email: "forged@example.com" }),
    }));
    expect(response.status).toBe(401);
    expect(recordTermsAcceptance).not.toHaveBeenCalled();
  });

  it("records the authenticated Clerk identity instead of caller email", async () => {
    currentUser.mockResolvedValue({
      id: "user_verified",
      primaryEmailAddress: { emailAddress: "verified@example.com" },
      emailAddresses: [],
    });
    recordTermsAcceptance.mockResolvedValue(undefined);
    const response = await POST(new Request("https://admin.example/api/terms/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ termsVersion: "1.0", email: "forged@example.com" }),
    }));
    expect(response.status).toBe(200);
    expect(recordTermsAcceptance).toHaveBeenCalledWith(
      "user_verified",
      "verified@example.com",
      null,
      null,
      "1.0"
    );
  });
});
