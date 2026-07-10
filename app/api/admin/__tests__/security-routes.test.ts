/** @jest-environment node */

import { readFileSync } from "fs";
import { resolve } from "path";

const routeFiles = [
  "app/api/admin/force-init-db/route.ts",
  "app/api/admin/init-database/route.ts",
  "app/api/admin/check-db/route.ts",
  "app/api/admin/init-async-table/route.ts",
  "app/api/admin/debug-user/route.ts",
  "app/api/debug/env/route.ts",
];

describe("dangerous admin route source policy", () => {
  it.each(routeFiles)("keeps %s free of HTTP-triggered DDL and stack output", (file) => {
    const source = readFileSync(resolve(process.cwd(), file), "utf8");
    expect(source).not.toMatch(/\b(?:CREATE|ALTER|DROP|TRUNCATE)\s+(?:TABLE|INDEX)\b/i);
    expect(source).not.toMatch(/(?:error\.)?stack\b/i);
  });

  it("does not accept admin passwords through the environment debug route", () => {
    const source = readFileSync(
      resolve(process.cwd(), "app/api/debug/env/route.ts"),
      "utf8"
    );
    expect(source).not.toContain("x-admin-password");
    expect(source).not.toMatch(/searchParams\.get\(["']key["']\)/);
  });

  it("uses timingSafeEqual for admin password verification", () => {
    const source = readFileSync(
      resolve(process.cwd(), "app/api/admin/auth/route.ts"),
      "utf8"
    );
    expect(source).toContain("timingSafeEqual");
  });
});
