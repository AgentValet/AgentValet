// packages/client/src/env.ts
//
// Environment resolution for AgentValet.fromEnv().
//
// Accepts BOTH naming conventions already in the wild: the bare names the
// mcp-server/MCPB write (AGENT_ID, OWNER_ID, PROXY_URL, AGENT_PRIVATE_KEY*)
// and AGENTVALET_-prefixed aliases, which is what the docs and the
// credentials-not-configured message tell people to set. A machine that has
// been through `npx @agentvalet/register` already satisfies the bare set, so
// fromEnv() works with zero extra config there.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "./errors.js";

export const DEFAULT_PROXY_URL = "https://api.agentvalet.ai";

// Treat empty strings and unresolved MCPB placeholders ("${user_config.foo}")
// as not-set. The MCPB writes literal placeholders when a user_config field is
// left blank, and a literal "${...}" agent id fails far more confusingly later.
function readEnv(name: string): string | null {
  const v = process.env[name];
  if (v === undefined) return null;
  const t = v.trim();
  if (t === "") return null;
  if (t.startsWith("${") && t.endsWith("}")) return null;
  return t;
}

/** AGENTVALET_-prefixed name wins over the bare name when both are set. */
function readEither(suffix: string): string | null {
  return readEnv(`AGENTVALET_${suffix}`) ?? readEnv(suffix);
}

export function agentIdFromEnv(): string | null {
  return readEither("AGENT_ID");
}

export function ownerIdFromEnv(): string | null {
  return readEither("OWNER_ID");
}

export function proxyUrlFromEnv(): string {
  return (readEither("PROXY_URL") ?? DEFAULT_PROXY_URL).replace(/\/$/, "");
}

/**
 * Resolves the RS256 private key PEM, in precedence order:
 *   1. AGENT_PRIVATE_KEY_B64  — base64-encoded PEM (12-factor / container safe)
 *   2. AGENT_PRIVATE_KEY_PATH — path to a PEM file
 *   3. AGENT_PRIVATE_KEY      — raw multi-line PEM, or \n-escaped single line
 *   4. ~/.agentvalet/agent.key — written by `npx @agentvalet/register`
 *
 * Same order and same formats as the mcp-server's pem.ts, so a dev who already
 * has the MCP server working can construct the SDK with no new setup.
 */
export function privateKeyFromEnv(): string {
  const b64 = readEither("AGENT_PRIVATE_KEY_B64");
  if (b64) return Buffer.from(b64, "base64").toString("utf-8").trim();

  const path = readEither("AGENT_PRIVATE_KEY_PATH");
  if (path) {
    try {
      return readFileSync(path, "utf-8").trim();
    } catch (err) {
      throw new ConfigError(
        `Cannot read AGENT_PRIVATE_KEY_PATH (${path}): ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  const raw = readEither("AGENT_PRIVATE_KEY");
  if (raw) {
    const unescaped = raw.replace(/\\n/g, "\n");
    // Tolerate a bare base64 blob with the PEM armour stripped — a common
    // casualty of pasting a key through a secrets UI that trims delimiters.
    if (!unescaped.startsWith("-----")) {
      return `-----BEGIN PRIVATE KEY-----\n${unescaped}\n-----END PRIVATE KEY-----`;
    }
    return unescaped;
  }

  const diskKey = readDiskKey();
  if (diskKey) return diskKey;

  throw new ConfigError(
    "No private key found. Set AGENT_PRIVATE_KEY, AGENT_PRIVATE_KEY_PATH, or AGENT_PRIVATE_KEY_B64, " +
      "or run `npx @agentvalet/register` to create an agent and write ~/.agentvalet/agent.key.",
  );
}

function readDiskKey(): string | null {
  try {
    return readFileSync(join(homedir(), ".agentvalet", "agent.key"), "utf-8").trim() || null;
  } catch {
    return null;
  }
}
