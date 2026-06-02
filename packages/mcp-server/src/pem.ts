import { readFileSync } from "fs";
import { readBoundPrivateKey } from "./bind.js";

/**
 * Reads the RS256 private key from environment variables, supporting four formats:
 * - AGENT_PRIVATE_KEY_B64: base64-encoded PEM
 * - AGENT_PRIVATE_KEY_PATH: path to a PEM file
 * - AGENT_PRIVATE_KEY: raw multi-line PEM or \n-escaped single-line PEM
 *
 * Falls back to the disk-persisted invite-bind key at
 * ~/.agentvalet/agent.key when no env-based source is present. This is
 * the path written by the invite-flow first-run bind (see bind.ts) —
 * having pem.ts honour it means subsequent invocations of the
 * mcp-server don't need any env vars at all.
 */
// Treat empty + unresolved MCPB placeholders ("${user_config.foo}") as
// not-set — see config.ts for the same defence on identity envs.
function readEnv(name: string): string | null {
  const v = process.env[name];
  if (v === undefined) return null;
  const t = v.trim();
  if (t === "") return null;
  if (t.startsWith("${") && t.endsWith("}")) return null;
  return t;
}

export function readPrivateKeyFromEnv(): string {
  // 1. Base64-encoded PEM
  const b64 = readEnv("AGENT_PRIVATE_KEY_B64");
  if (b64) {
    return Buffer.from(b64, "base64").toString("utf-8").trim();
  }

  // 2. Path to PEM file
  const path = readEnv("AGENT_PRIVATE_KEY_PATH");
  if (path) {
    try {
      return readFileSync(path, "utf-8").trim();
    } catch (err) {
      throw new Error(`Cannot read AGENT_PRIVATE_KEY_PATH: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 3. Raw PEM content (multi-line or \n-escaped)
  const rawEnv = readEnv("AGENT_PRIVATE_KEY");
  if (rawEnv) {
    const raw = rawEnv;
    // Unescape \n sequences
    const unescaped = raw.replace(/\\n/g, "\n");
    // Wrap bare base64 blob without headers
    if (!unescaped.startsWith("-----")) {
      return `-----BEGIN PRIVATE KEY-----\n${unescaped}\n-----END PRIVATE KEY-----`;
    }
    return unescaped;
  }

  // 4. Disk fallback — written by the invite-bind first-run flow.
  const diskKey = readBoundPrivateKey();
  if (diskKey) return diskKey;

  throw new Error(
    "No private key provided. Set AGENT_PRIVATE_KEY, AGENT_PRIVATE_KEY_PATH, or AGENT_PRIVATE_KEY_B64, " +
      "or run the invite-bind flow with INVITE_BIND_SECRET.",
  );
}
