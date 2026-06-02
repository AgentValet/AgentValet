#!/usr/bin/env node
// Release the AgentValet MCPB bundle.
//
// Bumps the patch version in both package.json and manifest.json, runs the
// build script, then packs a versioned .mcpb plus a rolling agentvalet-latest.mcpb
// copy. Use `pnpm release` whenever you want a fresh artifact for upload to
// Supabase Storage — the version on the file tells you what's in it.
//
// Skip the bump with `pnpm release --no-bump` (rebuild the current version).
// Force a specific version with `pnpm release --version=1.2.3`.

import { execSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bundleRoot = resolve(__dirname, "..");
const packageJsonPath = join(bundleRoot, "package.json");
const manifestPath = join(bundleRoot, "manifest.json");

const args = process.argv.slice(2);
const noBump = args.includes("--no-bump");
const explicitVersion = args.find((a) => a.startsWith("--version="))?.slice("--version=".length);

function bumpPatch(version) {
  const parts = version.split(".").map((n) => parseInt(n, 10));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`Cannot bump non-semver version "${version}"`);
  }
  parts[2] += 1;
  return parts.join(".");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeJson(path, obj) {
  // Preserve trailing newline that editors typically add
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

// ── 1. Decide the new version ─────────────────────────────────────────────
const pkg = readJson(packageJsonPath);
const manifest = readJson(manifestPath);
const currentVersion = pkg.version;

let newVersion;
if (explicitVersion) {
  newVersion = explicitVersion;
} else if (noBump) {
  newVersion = currentVersion;
} else {
  newVersion = bumpPatch(currentVersion);
}

if (pkg.version !== manifest.version) {
  console.warn(
    `[release] WARNING: package.json (${pkg.version}) and manifest.json (${manifest.version}) ` +
      `were already out of sync. Aligning both to ${newVersion}.`,
  );
}

// ── 2. Write the new version into both files ──────────────────────────────
if (!noBump || explicitVersion) {
  pkg.version = newVersion;
  manifest.version = newVersion;
  writeJson(packageJsonPath, pkg);
  writeJson(manifestPath, manifest);
  console.log(`[release] version: ${currentVersion} → ${newVersion}`);
} else {
  console.log(`[release] --no-bump: keeping version ${newVersion}`);
}

// ── 3. Run the build (stages build/ from the updated manifest) ────────────
execSync("node scripts/build.mjs", { cwd: bundleRoot, stdio: "inherit" });

// ── 4. Pack with a versioned filename ─────────────────────────────────────
const versionedFile = `agentvalet-${newVersion}.mcpb`;
const latestFile = "agentvalet-latest.mcpb";

execSync(`npx --no-install @anthropic-ai/mcpb pack build ${versionedFile}`, {
  cwd: bundleRoot,
  stdio: "inherit",
});

// ── 5. Mirror as agentvalet-latest.mcpb so the dashboard download link
//      always points at the newest artifact without rewriting URLs ─────────
copyFileSync(join(bundleRoot, versionedFile), join(bundleRoot, latestFile));

console.log("");
console.log(`✓ Built ${versionedFile}`);
console.log(`✓ Copied to ${latestFile}`);
console.log("");
console.log("Next: upload both files to the Supabase 'downloads' bucket.");
console.log("  - agentvalet-latest.mcpb   (overwrites the current latest)");
console.log(`  - ${versionedFile}   (immutable pin for enterprise rollouts)`);
