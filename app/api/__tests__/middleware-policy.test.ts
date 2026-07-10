/** @jest-environment node */

import { NextRequest } from "next/server";
import {
  isPublicClerkPage,
  isPublicInfrastructureRequest,
} from "@/middleware";

const request = (path: string, method = "GET") =>
  new NextRequest(`https://admin.example${path}`, { method });

describe("admin middleware public infrastructure policy", () => {
  it("allows only the exact Clerk webhook method", () => {
    expect(isPublicInfrastructureRequest(request("/api/webhooks/clerk", "POST"))).toBe(true);
    expect(isPublicInfrastructureRequest(request("/api/webhooks/clerk/evil", "POST"))).toBe(false);
    expect(isPublicInfrastructureRequest(request("/api/webhooks/clerk", "GET"))).toBe(false);
  });

  it("allows only exact desktop update asset names", () => {
    expect(isPublicInfrastructureRequest(request("/api/desktop-update/latest.yml"))).toBe(true);
    expect(isPublicInfrastructureRequest(request("/api/desktop-update/app.exe"))).toBe(true);
    expect(isPublicInfrastructureRequest(request("/api/desktop-update/app.exe.blockmap"))).toBe(true);
    expect(isPublicInfrastructureRequest(request("/api/desktop-update/nested/app.exe"))).toBe(false);
    expect(isPublicInfrastructureRequest(request("/api/desktop-update/latest.yml/evil"))).toBe(false);
    expect(isPublicInfrastructureRequest(request("/api/desktop-update/app.exe", "POST"))).toBe(false);
  });

  it("does not turn similarly-prefixed dynamic routes into public pages", () => {
    expect(isPublicClerkPage(request("/sign-in"))).toBe(true);
    expect(isPublicClerkPage(request("/sign-in/sso-callback"))).toBe(true);
    expect(isPublicClerkPage(request("/sign-in.attacker"))).toBe(false);
    expect(isPublicClerkPage(request("/sign-up-evil"))).toBe(false);
    expect(isPublicClerkPage(request("/private.rsc"))).toBe(false);
  });
});
