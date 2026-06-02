import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { getStoredConfig, AGENT_KEY_PATH } from "../config/store.js";
import chalk from "chalk";

const NO_AGENT_MSG =
  chalk.red("\n  ✗ No agent registered.\n") +
  chalk.dim(
    "  Run the following command first to register an agent in this directory:\n\n" +
    "    npx @agentvalet/register\n"
  );

function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    result[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return result;
}

export interface AgentCredentials {
  agentId: string;
  ownerId: string;
  keyPath: string;
  apiUrl: string;
}

/**
 * Resolves agent credentials in priority order:
 *   1. ~/.agentvalet/config.json  (machine-level, canonical)
 *   2. .env.agentvalet in cwd     (legacy project-level, read-only fallback)
 *   3. Environment variables      (AGENTVALET_AGENT_ID etc.)
 *
 * If no credentials are found, prints a friendly message and exits.
 */
export function resolveAgent(envFile = ".env.agentvalet"): AgentCredentials {
  const creds = tryResolveAgent(envFile);
  if (!creds) {
    process.stderr.write(NO_AGENT_MSG + "\n");
    process.exit(1);
  }
  return creds;
}

/**
 * Same as resolveAgent but returns null instead of exiting.
 */
export function tryResolveAgent(envFile = ".env.agentvalet"): AgentCredentials | null {
  let agentId: string | undefined;
  let ownerId: string | undefined;
  let apiUrl = "https://api.agentvalet.ai";
  let keyPath: string | undefined;

  // ── 1. Machine-level config: ~/.agentvalet/config.json ────────────────────
  try {
    const stored = getStoredConfig();
    agentId = stored.agentId ?? stored.lastAgentId ?? undefined;
    ownerId = stored.ownerId ?? undefined;
    apiUrl  = stored.apiUrl ?? stored.proxyUrl ?? apiUrl;
    keyPath = stored.keyPath ?? stored.lastKeyPath ?? undefined;
  } catch { /* not configured */ }

  // Default key path to machine location if not set
  if (!keyPath) keyPath = AGENT_KEY_PATH;

  // ── 2. Legacy: .env.agentvalet in cwd (read-only fallback) ───────────────
  if (!agentId || !ownerId) {
    const envPath = resolve(envFile);
    if (existsSync(envPath)) {
      try {
        const vars = parseEnvFile(readFileSync(envPath, "utf-8"));
        agentId = agentId ?? vars["AGENTVALET_AGENT_ID"];
        ownerId = ownerId ?? vars["AGENTVALET_OWNER_ID"];
        apiUrl  = vars["AGENTVALET_API_URL"] ?? apiUrl;
        keyPath = vars["AGENTVALET_PRIVATE_KEY_PATH"] ?? keyPath;
      } catch { /* fall through */ }
    }
  }

  // ── 3. Environment variables ──────────────────────────────────────────────
  agentId = agentId ?? process.env["AGENTVALET_AGENT_ID"];
  ownerId = ownerId ?? process.env["AGENTVALET_OWNER_ID"];
  if (process.env["AGENTVALET_API_URL"]) apiUrl = process.env["AGENTVALET_API_URL"];
  if (process.env["AGENTVALET_PRIVATE_KEY_PATH"]) keyPath = process.env["AGENTVALET_PRIVATE_KEY_PATH"];

  if (!agentId || !ownerId || !keyPath) return null;
  if (!existsSync(resolve(keyPath))) return null;

  return { agentId, ownerId, keyPath, apiUrl };
}
