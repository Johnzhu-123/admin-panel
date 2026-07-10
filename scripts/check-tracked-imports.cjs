#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const SOURCE_ROOTS = ["app", "components", "lib", "scripts"];
const IMPORT_PATTERN = /(?:import\s+(?:[^"']*?\s+from\s+)?|export\s+[^"']*?\s+from\s+|import\s*\(|require\s*\()\s*["']([^"']+)["']/g;

function gitLines(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).split(/\r?\n/)
    .map((line) => line.trim()).filter(Boolean).map((line) => line.replace(/\\/g, "/"));
}

function candidatePaths(importer, specifier, root = path.resolve(__dirname, "..")) {
  const base = specifier.startsWith("@/")
    ? path.resolve(root, specifier.slice(2))
    : path.resolve(path.dirname(importer), specifier);
  const candidates = [base];
  for (const extension of SOURCE_EXTENSIONS) candidates.push(`${base}${extension}`);
  for (const extension of SOURCE_EXTENSIONS) candidates.push(path.join(base, `index${extension}`));
  return candidates;
}

function findUntrackedImports(root) {
  const tracked = new Set(gitLines(root, ["ls-files"]));
  const sourceFiles = [...tracked].filter((file) =>
    SOURCE_ROOTS.some((sourceRoot) => file === sourceRoot || file.startsWith(`${sourceRoot}/`)) &&
    /\.(?:[cm]?[jt]sx?|json)$/.test(file)
  );
  const failures = [];
  for (const relativeImporter of sourceFiles) {
    const importer = path.join(root, relativeImporter);
    if (!fs.existsSync(importer)) continue;
    const source = fs.readFileSync(importer, "utf8");
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1];
      if (!specifier.startsWith(".") && !specifier.startsWith("@/")) continue;
      const resolved = candidatePaths(importer, specifier, root).find(
        (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()
      );
      if (!resolved) continue;
      const relativeResolved = path.relative(root, resolved).replace(/\\/g, "/");
      if (!tracked.has(relativeResolved)) failures.push(`${relativeImporter} -> ${specifier} (${relativeResolved})`);
    }
  }
  return [...new Set(failures)].sort();
}

function main(root = path.resolve(__dirname, "..")) {
  const failures = findUntrackedImports(root);
  if (failures.length) {
    console.error("[tracked-imports] Tracked source imports untracked local files:");
    for (const failure of failures) console.error(`  - ${failure}`);
    return 1;
  }
  console.log("[tracked-imports] All local imports from tracked sources resolve to tracked files.");
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { candidatePaths, findUntrackedImports, main };
