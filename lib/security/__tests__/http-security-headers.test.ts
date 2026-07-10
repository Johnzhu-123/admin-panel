/** @jest-environment node */

import {
  applyHttpSecurityHeaders,
  buildHttpSecurityHeaders,
} from "@/lib/security/http-security-headers";

describe("HTTP security headers", () => {
  it("enforces the baseline isolation and resource boundaries", () => {
    const headers = new Map(
      buildHttpSecurityHeaders({
        isProduction: true,
        isHttps: true,
        isLoopback: false,
      }).map(({ key, value }) => [key, value])
    );
    expect(headers.get("Content-Security-Policy")).toContain("object-src 'none'");
    expect(headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(headers.get("Content-Security-Policy")).toContain("asset:");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Strict-Transport-Security")).toContain("max-age=31536000");
  });

  it("does not emit HSTS for loopback desktop traffic", () => {
    const headers = buildHttpSecurityHeaders({
      isProduction: true,
      isHttps: true,
      isLoopback: true,
    });
    expect(headers.some(({ key }) => key === "Strict-Transport-Security")).toBe(false);
  });

  it("adds a nonce policy in report-only mode without weakening baseline enforcement", () => {
    const headers = new Headers();
    applyHttpSecurityHeaders(headers, {
      isProduction: true,
      isHttps: true,
      isLoopback: false,
      nonce: "0123456789abcdef0123456789abcdef",
      strictCspMode: "report-only",
    });
    expect(headers.get("content-security-policy")).toContain("'unsafe-inline'");
    expect(headers.get("content-security-policy-report-only")).toContain(
      "'strict-dynamic'"
    );
    expect(headers.get("content-security-policy-report-only")).toContain(
      "'nonce-0123456789abcdef0123456789abcdef'"
    );
  });

  it("fails closed when strict mode has no nonce", () => {
    expect(() =>
      buildHttpSecurityHeaders({
        isProduction: true,
        isHttps: true,
        isLoopback: false,
        strictCspMode: "enforce",
      })
    ).toThrow(/nonce/i);
  });
});
