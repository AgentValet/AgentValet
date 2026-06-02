#!/usr/bin/env node
// Build the AgentValet MCPB bundle.
// Copies the compiled mcp-server into ./build/server/, installs production
// dependencies only, copies manifest + icon, and leaves a directory ready for
// `mcpb pack build agentvalet.mcpb`.

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bundleRoot = resolve(__dirname, "..");
const repoRoot = resolve(bundleRoot, "..", "..");
const mcpServerRoot = join(repoRoot, "packages", "mcp-server");
const buildDir = join(bundleRoot, "build");
const buildServerDir = join(buildDir, "server");

function step(label, fn) {
  process.stdout.write(`[mcpb] ${label}... `);
  try {
    fn();
    process.stdout.write("ok\n");
  } catch (err) {
    process.stdout.write("fail\n");
    throw err;
  }
}

step("clean build dir", () => {
  if (existsSync(buildDir)) rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });
});

step("compile mcp-server", () => {
  execSync("pnpm run build", { cwd: mcpServerRoot, stdio: "inherit" });
});

step("stage compiled server", () => {
  cpSync(join(mcpServerRoot, "dist"), buildServerDir, { recursive: true });
});

step("write minimal server package.json", () => {
  const src = JSON.parse(readFileSync(join(mcpServerRoot, "package.json"), "utf-8"));
  const minimal = {
    name: src.name,
    version: src.version,
    type: "module",
    main: "index.js",
    dependencies: src.dependencies,
  };
  writeFileSync(join(buildServerDir, "package.json"), JSON.stringify(minimal, null, 2));
});

step("install production deps", () => {
  execSync("npm install --omit=dev --no-audit --no-fund --ignore-scripts", {
    cwd: buildServerDir,
    stdio: "inherit",
  });
});

step("copy manifest + icon + README", () => {
  cpSync(join(bundleRoot, "manifest.json"), join(buildDir, "manifest.json"));
  const icon = join(bundleRoot, "icon.png");
  if (existsSync(icon)) cpSync(icon, join(buildDir, "icon.png"));
  const readme = join(bundleRoot, "README.md");
  if (existsSync(readme)) cpSync(readme, join(buildDir, "README.md"));
});

console.log("\nBundle staged at:", buildDir);
console.log("Next: cd apps/mcpb && npx @anthropic-ai/mcpb pack build agentvalet.mcpb");
