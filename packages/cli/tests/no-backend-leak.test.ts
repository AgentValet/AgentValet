import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

// Regression guard for the open-core scrub (CodePrompts/CLI-Proxy-Passthrough/).
// The published CLI must talk only to the AgentValet proxy — no Supabase project
// ref, anon/publishable key, or *.supabase.co host may reappear in the source.
// All onboarding calls go through https://api.agentvalet.ai/functions/v1/*, which
// injects the gateway key server-side.

const SRC_DIR = join(__dirname, "..", "src");

// Patterns that would indicate the backend vendor leaked back into the CLI.
const FORBIDDEN: Array<{ name: string; re: RegExp }> = [
  { name: "supabase host", re: /\.supabase\.co/ },
  { name: "project ref", re: /jmodblrolfoavrxqgbps/ },
  { name: "supabase JWT/anon/publishable key", re: /eyJhbGci|sb_publishable_|sb_secret_/ },
  { name: "SUPABASE_ env constant", re: /SUPABASE_(URL|ANON|SERVICE)/ },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("open-core: no backend leak in CLI source", () => {
  const files = walk(SRC_DIR);

  it("scans a non-trivial number of source files", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const { name, re } of FORBIDDEN) {
    it(`contains no ${name}`, () => {
      const offenders = files.filter((f) => re.test(readFileSync(f, "utf-8")));
      expect(
        offenders,
        `Backend tell "${name}" leaked into:\n${offenders.join("\n")}`,
      ).toEqual([]);
    });
  }
});
