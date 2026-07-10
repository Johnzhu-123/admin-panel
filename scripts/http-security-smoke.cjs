#!/usr/bin/env node
"use strict";

const REQUIRED_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": null,
  "permissions-policy": null,
  "content-security-policy": null,
};

async function verifySecurityHeaders(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, { redirect: "manual" });
  const failures = [];
  for (const [name, expected] of Object.entries(REQUIRED_HEADERS)) {
    const actual = response.headers.get(name);
    if (!actual) failures.push(`${name} is missing`);
    else if (expected && actual.toLowerCase() !== expected.toLowerCase()) failures.push(`${name} expected ${expected}, received ${actual}`);
  }
  if (new URL(url).protocol === "https:" && !response.headers.get("strict-transport-security")) failures.push("strict-transport-security is missing on HTTPS");
  return { status: response.status, failures };
}

async function main() {
  const url = process.argv[2] || process.env.SMOKE_URL || "http://127.0.0.1:3000/";
  const result = await verifySecurityHeaders(url);
  if (result.failures.length) throw new Error(`HTTP security smoke failed (${result.status}): ${result.failures.join("; ")}`);
  console.log(`[http-smoke] ${url} returned ${result.status} with required security headers.`);
}

if (require.main === module) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
module.exports = { REQUIRED_HEADERS, verifySecurityHeaders };
