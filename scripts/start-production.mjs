import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runNodeScript(script, args = []) {
  const result = spawnSync(process.execPath, [path.join(root, script), ...args], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${script} failed with exit code ${result.status}`);
  }
}

function runSecurityMigration() {
  if (process.env.RUN_SECURITY_MIGRATIONS_ON_START !== "1") return;

  const mode = String(process.env.SECURITY_MIGRATION_MODE || "").toLowerCase();
  if (mode !== "dry-run" && mode !== "apply") {
    throw new Error(
      "SECURITY_MIGRATION_MODE must be either dry-run or apply when startup migrations are enabled"
    );
  }

  runNodeScript("scripts/migrate-security-schema.mjs");
  if (mode === "dry-run") {
    runNodeScript("scripts/migrate-encrypted-secrets.mjs", ["--dry-run"]);
    return;
  }
  runNodeScript("scripts/migrate-encrypted-secrets.mjs");
  runNodeScript("scripts/verify-encrypted-secrets.mjs");
}

try {
  runSecurityMigration();
} catch (error) {
  console.error(
    "Production startup migration failed:",
    error instanceof Error ? error.message : error
  );
  process.exit(1);
}

const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
const server = spawn(process.execPath, [nextBin, "start"], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});

process.on("SIGINT", () => server.kill("SIGINT"));
process.on("SIGTERM", () => server.kill("SIGTERM"));

server.on("error", (error) => {
  console.error("Failed to start Next.js:", error);
  process.exit(1);
});
server.on("exit", (code, signal) => {
  process.exit(signal ? 0 : (code ?? 1));
});
