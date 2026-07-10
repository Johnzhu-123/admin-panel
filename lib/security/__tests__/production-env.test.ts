import { spawnSync } from "node:child_process";
import path from "node:path";

const scriptPath = path.resolve(
  process.cwd(),
  "scripts/check-production-env.cjs"
);

const validEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  ADMIN_PASSWORD: "placeholder-admin-password-2026",
  POSTGRES_URL:
    "postgresql://placeholder:placeholder@pool.example.com:5432/app?sslmode=require",
  POSTGRES_URL_NON_POOLING:
    "postgresql://placeholder:placeholder@direct.example.com:5432/app?sslmode=require",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_placeholder",
  CLERK_SECRET_KEY: "sk_live_placeholder",
  CLERK_WEBHOOK_SECRET: "whsec_placeholder_1234567890",
  BUILT_IN_ENCRYPTION_KEY:
    "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  BUILT_IN_ENCRYPTION_KEY_ID: "placeholder-2026-07",
};

function runCheck(overrides: Record<string, string | undefined> = {}) {
  const env = { ...validEnvironment, ...overrides };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete env[name];
  }
  return spawnSync(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    env,
  });
}

describe("production PostgreSQL environment validation", () => {
  test("rejects a missing direct PostgreSQL URL", () => {
    const result = runCheck({ POSTGRES_URL_NON_POOLING: undefined });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("POSTGRES_URL_NON_POOLING is required");
  });

  test("rejects a non-PostgreSQL direct URL", () => {
    const result = runCheck({
      POSTGRES_URL_NON_POOLING: "https://direct.example.com/database",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "POSTGRES_URL_NON_POOLING must be a direct PostgreSQL connection URL"
    );
  });

  test("accepts valid pooled and direct PostgreSQL URLs", () => {
    const result = runCheck();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Production environment check passed.");
  });
});
