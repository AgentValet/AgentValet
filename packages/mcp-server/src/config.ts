import { readPrivateKeyFromEnv } from "./pem.js";
import { importPKCS8 } from "jose";
import {
  attemptInviteBind,
  readBoundIdentity,
  readBoundPrivateKey,
} from "./bind.js";

export interface Config {
  agentId: string;
  ownerId: string;
  proxyUrl: string;
  privateKeyPem: string | null;  // null = PENDING_FIRST_CALL (key not yet provided)
  privateKey: Awaited<ReturnType<typeof importPKCS8>> | null;
}

const DEFAULT_PROXY_URL = "https://api.agentvalet.ai";

/**
 * Resolves the agent's identity + private key. Three paths:
 *
 *   1. Env-based — AGENT_ID + OWNER_ID + PROXY_URL + AGENT_PRIVATE_KEY*
 *      provided. Legacy path; preserved unchanged.
 *
 *   2. Disk identity — env vars are missing but ~/.agentvalet/agent.json
 *      and ~/.agentvalet/agent.key exist (e.g. from a previous bind).
 *      Read them and proceed as if env had been set.
 *
 *   3. Invite-bind first run — INVITE_BIND_SECRET is set, no identity
 *      is yet on disk, and no AGENT_ID env. Generate a keypair, POST
 *      /v1/invites/bind, persist the result, then proceed.
 *
 * Order matters: env wins (explicit > implicit), then disk identity,
 * then invite-bind. The bind path runs at most once per machine —
 * the secret is consumed after first use.
 */
// Treat empty strings AND unresolved MCPB template placeholders (e.g.
// "${user_config.agent_id}") as "not set". Claude Desktop on some platforms
// passes the literal placeholder through when a user_config field has no
// value and no manifest default — that would otherwise false-trigger the
// env-based Path 1 below and skip the invite-bind handshake.
function envOrNull(name: string): string | null {
  const v = process.env[name];
  if (v === undefined) return null;
  const t = v.trim();
  if (t === "") return null;
  if (t.startsWith("${") && t.endsWith("}")) return null;
  return t;
}

export async function validateConfig(): Promise<Config> {
  // Path 1 — env-based (legacy).
  const envAgentId = envOrNull("AGENT_ID");
  const envOwnerId = envOrNull("OWNER_ID");
  const envProxyUrl = envOrNull("PROXY_URL");

  if (envAgentId && envOwnerId && envProxyUrl) {
    return buildConfig({
      agentId: envAgentId,
      ownerId: envOwnerId,
      proxyUrl: envProxyUrl,
    });
  }

  // Path 2 — disk identity from a previous bind.
  const diskIdentity = readBoundIdentity();
  const diskKey = readBoundPrivateKey();
  if (diskIdentity && diskKey) {
    return buildConfig({
      agentId: envAgentId ?? diskIdentity.agent_id,
      ownerId: envOwnerId ?? diskIdentity.owner_id,
      proxyUrl: envProxyUrl ?? diskIdentity.proxy_url,
    });
  }

  // Path 3 — first-run invite bind.
  const inviteBindSecret = envOrNull("INVITE_BIND_SECRET");
  if (inviteBindSecret) {
    const proxyUrl = (envProxyUrl ?? DEFAULT_PROXY_URL).replace(/\/$/, "");
    process.stderr.write(
      `[mcp-server] First-run invite bind against ${proxyUrl}…\n`,
    );
    try {
      const { identity } = await attemptInviteBind({
        bindSecret: inviteBindSecret,
        proxyUrl,
      });
      process.stderr.write(
        `[mcp-server] Bound as ${identity.agent_id} (owner ${identity.owner_id}). Key persisted to ~/.agentvalet/agent.key\n`,
      );
      return buildConfig({
        agentId: identity.agent_id,
        ownerId: identity.owner_id,
        proxyUrl: identity.proxy_url,
      });
    } catch (err) {
      process.stderr.write(
        `[mcp-server] Invite bind failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  }

  // Nothing usable — boot credential-less instead of exiting.
  //
  // Introspection (initialize + tools/list) must work with NO credentials so
  // a sandbox (e.g. Glama) can start the server and read the static tool
  // catalogue. We therefore return a config with an EMPTY identity and a NULL
  // key rather than process.exit(1). The credential requirement is deferred to
  // tools/call: an authed tool invoked with no usable identity returns a clean
  // "credentials not configured" tool result (see index.ts requireCredentials),
  // never a crash. An empty agentId is the signal for "state C — not configured"
  // (distinct from "state B — identity present, key pending" which keeps the
  // existing invite-bind pending response).
  const missing: string[] = [];
  for (const key of ["AGENT_ID", "OWNER_ID", "PROXY_URL"] as const) {
    if (!process.env[key]) missing.push(key);
  }
  process.stderr.write(
    `[mcp-server] No credentials configured (${missing.join(", ")} unset, no disk ` +
      `identity, no INVITE_BIND_SECRET). Booting in introspection-only mode: ` +
      `tools/list works; tools/call returns a credentials-required message. ` +
      `Set the env vars, run the invite-bind flow, or restore ` +
      `~/.agentvalet/agent.{key,json} to enable platform calls.\n`,
  );
  return buildConfig({ agentId: "", ownerId: "", proxyUrl: DEFAULT_PROXY_URL });
}

async function buildConfig(args: {
  agentId: string;
  ownerId: string;
  proxyUrl: string;
}): Promise<Config> {
  const proxyUrl = args.proxyUrl.replace(/\/$/, "");

  let privateKeyPem: string | null = null;
  let privateKey: Awaited<ReturnType<typeof importPKCS8>> | null = null;

  try {
    privateKeyPem = readPrivateKeyFromEnv();
  } catch {
    // No key — tools will return pending-activation response.
  }

  if (privateKeyPem !== null) {
    try {
      privateKey = await importPKCS8(privateKeyPem, "RS256");
    } catch (err) {
      // Don't crash the process on a malformed key — that would also take down
      // introspection. Drop the unusable key to null and log; tools/call will
      // return the credentials-required message instead of a hard exit.
      process.stderr.write(
        `[mcp-server] Invalid private key (ignored): ${err instanceof Error ? err.message : err}\n`,
      );
      privateKeyPem = null;
      privateKey = null;
    }
  }

  return { agentId: args.agentId, ownerId: args.ownerId, proxyUrl, privateKeyPem, privateKey };
}
