#!/usr/bin/env node
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const bundleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const target of ["build", "agentvalet.mcpb"]) {
  const p = join(bundleRoot, target);
  if (existsSync(p)) {
    rmSync(p, { recursive: true, force: true });
    console.log(`removed ${target}`);
  }
}
