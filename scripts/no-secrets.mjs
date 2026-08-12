#!/usr/bin/env node
// scripts/no-secrets.mjs
//
// Publish tripwire. Refuses to ship a package whose tarball contains ANY
// sensitive material — credentials, identity, internal infrastructure.
//
// Why this exists (near-miss 2026-08-12): `agentvalet-register refresh` seeds
// every directory it takes for a project, including packages/agents-md, whose
// .md files are PRODUCT TEMPLATES that package publishes. It appended the agent
// id, owner id, and the full approved platform/scope inventory to them. HEAD
// stayed clean so `git status` showed three unremarkable " M" lines. Publishing
// there would have been permanent: npm versions cannot be unpublished after 72h
// and can never be reused afterwards.
//
// Two independent layers, because either alone has a blind spot:
//
//   1. PATTERNS — known shapes (key material, vendor token formats, identity,
//      connection strings, internal hosts). Catches secrets this repo has never
//      seen, but only ones whose shape was anticipated.
//   2. ENV CROSS-CHECK — every value in the repo-root .env is searched for
//      verbatim in the shipping files. Catches ANY real secret regardless of
//      format, including ones no pattern would match. This is the stronger of
//      the two and the reason a bespoke script beats a generic scanner here.
//
// Scans exactly what `npm pack` would ship, so the `files` allowlist and
// .npmignore are honoured and the guard does not cry wolf over local-only
// artifacts. A guard that fires on noise gets switched off.
//
// Secret VALUES are never printed — only the variable name and the file.
//
// Run from a package directory. Exit 0 = clean, 1 = something sensitive found.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = process.cwd();
const REPO_ROOT = resolve(ROOT, "../..");

// ── Layer 1: shape-based patterns ────────────────────────────────────────────
// Deliberately value-shaped, not name-shaped: matching the word "password"
// finds documentation, matching an actual credential finds a leak.
const PATTERNS = [
  // — AgentValet identity / internal posture —
  { re: /\bagt_[a-z0-9]{16,}\b/i, what: "AgentValet agent id" },
  { re: /\bOwner ID:\s*`?[0-9a-f]{8}-[0-9a-f]{4}-/i, what: "owner id" },
  { re: /^#+\s*AgentValet Permissions\s*$/im, what: "injected permissions block" },
  { re: /Last refreshed:\s*\d{4}-\d{2}-\d{2}T/i, what: "register-refresh timestamp" },

  // — key material — requires a real base64 body; a bare PEM header is
  //   legitimate in key-validation code (pem.ts, env.ts, env.py all have one).
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\s]{100,}/, what: "private key material" },
  { re: /-----BEGIN OPENSSH PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\s]{100,}/, what: "SSH private key" },

  // — vendor credentials —
  { re: /\bnpm_[A-Za-z0-9]{36}\b/, what: "npm token" },
  { re: /\bpypi-[A-Za-z0-9_-]{40,}/, what: "PyPI token" },
  { re: /\bsk_(live|test)_[A-Za-z0-9]{16,}/, what: "Stripe secret key" },
  { re: /\b(ghp|gho|ghu|ghs)_[A-Za-z0-9]{36}\b/, what: "GitHub token" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/, what: "GitHub fine-grained PAT" },
  // Real shape is xoxb-<digits>-<digits>-<random>. Matching the looser
  // `xox?-anything` fires on the deliberate `xoxb-real-token-here` placeholder
  // in agents-md's "don't do this" example — teaching material, not a secret.
  { re: /\bxox[baprs]-\d{9,}-\d{9,}-[A-Za-z0-9]{20,}/, what: "Slack token" },
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: "AWS access key id" },
  { re: /\bsb_secret_[A-Za-z0-9_-]{20,}/, what: "Supabase secret key" },
  { re: /\bcfut_[A-Za-z0-9]{30,}/, what: "Cloudflare token" },
  { re: /\bnango_[A-Za-z0-9_-]{20,}/, what: "Nango secret key" },
  // Signed JWT: header.payload.signature with a real signature segment.
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/, what: "signed JWT" },

  // — connection strings with embedded credentials —
  { re: /\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s:@/]+@/i, what: "connection string with password" },

  // — internal infrastructure —
  { re: /\bhttps?:\/\/[a-z0-9]{20}\.supabase\.co/i, what: "Supabase project URL" },
  { re: /\bmcp-[a-z0-9]{20}-supabase-co\b/i, what: "internal Supabase project ref" },
  { re: /\b45\.63\.27\.179\b/, what: "production VM IP" },
  { re: /\bvault\.azure\.net\b/i, what: "Azure Key Vault hostname" },

  // — generic assignment of a long opaque value to a secret-ish name —
  {
    re: /\b(?:SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE_?KEY|CLIENT_SECRET|ACCESS_KEY)\b\s*[:=]\s*["']?[A-Za-z0-9_\-+/=]{20,}/i,
    what: "credential assigned to a secret-named variable",
  },
];

// Values this short, or this common, would produce noise rather than signal.
const MIN_ENV_VALUE_LEN = 12;
const ENV_VALUE_DENYLIST = new Set(["true", "false", "localhost", "development", "production"]);

// ── what would actually ship ─────────────────────────────────────────────────
function filesThatWouldShip() {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    shell: process.platform === "win32",
  });
  return (JSON.parse(out)[0]?.files ?? []).map((f) => f.path);
}

// ── Layer 2: real values from .env ───────────────────────────────────────────
function envSecrets() {
  const envPath = join(REPO_ROOT, ".env");
  if (!existsSync(envPath)) return [];
  const out = [];
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const name = m[1];
    const value = m[2].trim().replace(/^["']|["']$/g, "");
    if (value.length < MIN_ENV_VALUE_LEN) continue;
    if (ENV_VALUE_DENYLIST.has(value.toLowerCase())) continue;
    out.push({ name, value });
  }
  return out;
}

let shipping;
try {
  shipping = filesThatWouldShip();
} catch (err) {
  console.error(`[no-secrets] could not resolve the pack list: ${err.message}`);
  console.error("Refusing to publish rather than scanning nothing.");
  process.exit(1);
}

const SCAN_EXT = /\.(md|json|js|mjs|cjs|ts|tsx|map|yaml|yml|txt|py|toml|sh|html|css)$/i;
const secrets = envSecrets();
const hits = [];

for (const rel of shipping.filter((f) => SCAN_EXT.test(f))) {
  let text;
  try {
    text = readFileSync(join(ROOT, rel), "utf8");
  } catch {
    continue;
  }
  for (const { re, what } of PATTERNS) {
    if (re.test(text)) hits.push({ file: rel, what });
  }
  // Never print the value itself — the variable name localises it well enough.
  for (const { name, value } of secrets) {
    if (text.includes(value)) hits.push({ file: rel, what: `literal value of ${name} from .env` });
  }
}

const pkgName = (() => {
  try {
    return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).name;
  } catch {
    return ROOT;
  }
})();

if (hits.length === 0) {
  console.log(
    `[no-secrets] ok — ${pkgName}: ${shipping.length} shipping files, ` +
      `${PATTERNS.length} patterns, ${secrets.length} .env values cross-checked`,
  );
  process.exit(0);
}

console.error(`\n[no-secrets] REFUSING TO PUBLISH ${pkgName}\n`);
for (const h of hits) console.error(`  ${h.file}  —  ${h.what}`);
console.error(
  "\nSomething sensitive is inside the tarball this publish would upload.\n" +
    "If it is the AgentValet identity block, that is `agentvalet-register refresh`\n" +
    "seeding a package directory it mistook for a project: restore with\n" +
    "`git checkout -- <package>` and delete any injected .claude/ and .mcp.json.\n" +
    "Do NOT publish past this. npm versions cannot be unpublished after 72h and\n" +
    "can never be reused afterwards; assume anything uploaded is permanent.\n",
);
process.exit(1);
