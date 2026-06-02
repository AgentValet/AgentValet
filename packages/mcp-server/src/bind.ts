// First-run invite bind for AgentValet MCP server.
//
// Triggered when INVITE_BIND_SECRET is set in env and no agent identity
// (AGENT_ID + private key) is yet available. We generate an RSA-2048
// keypair locally, POST the public key + bind_secret to /v1/invites/bind,
// and persist the returned identity + private key to ~/.agentvalet/.
//
// The bind_secret is one-shot, with a 30-minute TTL — the proxy returns
// 410 on replay. We DO NOT retry, because a 410 either means the secret
// was already consumed by an earlier run (so the identity should already
// be on disk) or it expired (the invitee needs a re-issue).
//
// Persistence layout (created with permission 0700 on the parent dir):
//   ~/.agentvalet/agent.key   PEM-encoded private key, mode 0600
//   ~/.agentvalet/agent.json  { agent_id, owner_id, proxy_url, bound_at }

import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENTVALET_DIR = join(homedir(), ".agentvalet");
const KEY_PATH = join(AGENTVALET_DIR, "agent.key");
const IDENTITY_PATH = join(AGENTVALET_DIR, "agent.json");

export interface BoundIdentity {
  agent_id: string;
  owner_id: string;
  proxy_url: string;
  bound_at: string;
}

export interface BindResult {
  identity: BoundIdentity;
  privateKeyPem: string;
}

export function getAgentvaletDir(): string {
  return AGENTVALET_DIR;
}

export function getKeyPath(): string {
  return KEY_PATH;
}

export function getIdentityPath(): string {
  return IDENTITY_PATH;
}

/**
 * Reads a previously-bound identity from disk, if one exists. Returns
 * null when the file is absent or unparseable — callers should treat
 * that as "no identity yet, proceed with bind".
 */
export function readBoundIdentity(): BoundIdentity | null {
  if (!existsSync(IDENTITY_PATH)) return null;
  try {
    const raw = readFileSync(IDENTITY_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<BoundIdentity>;
    if (
      typeof parsed.agent_id === "string" &&
      typeof parsed.owner_id === "string" &&
      typeof parsed.proxy_url === "string"
    ) {
      return parsed as BoundIdentity;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Returns the disk-stored private key PEM if present, otherwise null.
 */
export function readBoundPrivateKey(): string | null {
  if (!existsSync(KEY_PATH)) return null;
  try {
    return readFileSync(KEY_PATH, "utf-8").trim();
  } catch {
    return null;
  }
}

interface BindEndpointResponse {
  agent_id: string;
  owner_id: string;
  proxy_url: string;
  status: string;
}

/**
 * Generates an RSA-2048 keypair, POSTs the public key + bind_secret to
 * the proxy, and persists both the returned identity and the private
 * key to ~/.agentvalet/.
 *
 * Caller is responsible for deciding when to invoke (e.g. only when
 * INVITE_BIND_SECRET is set and no identity already exists on disk).
 */
export async function attemptInviteBind(opts: {
  bindSecret: string;
  proxyUrl: string;
}): Promise<BindResult> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const url = `${opts.proxyUrl.replace(/\/$/, "")}/v1/invites/bind`;
  // 15s hard timeout: Claude Desktop kills the transport at ~12-15s of
  // silence. If the proxy hangs, fail visibly with stderr rather than
  // letting the host record an unexplained "transport closed".
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bind_secret: opts.bindSecret,
        public_key_pem: publicKey,
      }),
      signal: ac.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Bind request timed out after 15s — proxy unreachable or slow.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json() as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      // ignore
    }
    if (res.status === 410) {
      throw new Error(
        `Bind secret rejected (${detail}). It was either already used or expired — ask the inviting manager to re-issue.`,
      );
    }
    throw new Error(`Invite bind failed: ${detail}`);
  }

  const payload = await res.json() as BindEndpointResponse;
  if (!payload.agent_id || !payload.owner_id || !payload.proxy_url) {
    throw new Error("Bind succeeded but response was missing required fields");
  }

  const identity: BoundIdentity = {
    agent_id: payload.agent_id,
    owner_id: payload.owner_id,
    proxy_url: payload.proxy_url,
    bound_at: new Date().toISOString(),
  };

  persistBindArtifacts(identity, privateKey);

  return { identity, privateKeyPem: privateKey };
}

/**
 * Writes the private key + identity to ~/.agentvalet/. The directory
 * is created with 0700 if it does not yet exist; the key file is
 * written with 0600. Identity is non-secret (no token material) but
 * we keep it inside the same directory for cleanup symmetry.
 *
 * Exposed so tests can verify the on-disk layout without making a
 * real HTTP call.
 */
export function persistBindArtifacts(identity: BoundIdentity, privateKeyPem: string): void {
  mkdirSync(AGENTVALET_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(KEY_PATH, privateKeyPem, { mode: 0o600 });
  writeFileSync(IDENTITY_PATH, JSON.stringify(identity, null, 2));
}
