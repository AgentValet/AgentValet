// apps/mcp-server/src/auth.ts
//
// Credentialed request layer: JWT signing, the auth+retry fetch wrapper, the
// credential gate, and the two no-key response shapes. All take the
// ServerContext (config + server) explicitly — extracted from index.ts during
// the modularization (Critique-Roadmap prompt 06.4); behavior unchanged.

import { SignJWT } from "jose";
import { fetchWithTimeout } from "./net.js";
import type { ServerContext } from "./context.js";

export async function signJWT(ctx: ServerContext): Promise<string> {
  if (!ctx.privateKey) throw new Error("Private key not loaded");
  return new SignJWT({ agent_id: ctx.AGENT_ID, owner_id: ctx.OWNER_ID })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(ctx.privateKey);
}

async function notifyBindSecret(ctx: ServerContext) {
  try {
    await fetchWithTimeout(
      `${ctx.PROXY_URL}/v1/bind-secret`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: ctx.AGENT_ID, owner_id: ctx.OWNER_ID }),
      },
      8_000,
    );
  } catch {
    // best-effort — don't block the error response
  }
}

function pendingFirstCallResponse() {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        error: "Agent not yet activated — owner confirmation pending. Retry in 60 seconds.",
      }),
    }],
    isError: true as const,
  };
}

// State C — no credentials at all (empty env / Glama-style sandbox). The
// server still boots and answers introspection; an authed tool call lands
// here and gets an actionable message instead of a crash. Distinct from the
// state-B "owner confirmation pending" response above, which means an identity
// IS configured but its key hasn't arrived yet.
function credentialsNotConfiguredResponse() {
  return {
    content: [{
      type: "text" as const,
      text:
        "AgentValet credentials are not configured. Set AGENTVALET_AGENT_ID, " +
        "AGENTVALET_OWNER_ID, and the agent private key (and optionally " +
        "AGENTVALET_PROXY_URL). Run npx @agentvalet/register to create an agent. " +
        "Docs: https://github.com/AgentValet/AgentValet#quickstart",
    }],
    isError: true as const,
  };
}

// Credential gate for authed tools/call. Returns null when the call may
// proceed (state A — a JWT can be signed), or a ready-to-return MCP tool
// result for the two no-key states:
//   • state B (identity present, key pending) → existing invite-bind pending
//     response, preserving the MCPB first-run flow.
//   • state C (no identity at all)            → credentials-not-configured.
// The no-auth tools (agent_register / agent_status) intentionally never call
// this — you must be able to register in order to OBTAIN credentials.
export async function requireCredentials(ctx: ServerContext) {
  if (ctx.AGENT_PRIVATE_KEY_RAW !== null) return null;
  if (ctx.AGENT_ID && ctx.OWNER_ID) {
    await notifyBindSecret(ctx);
    return pendingFirstCallResponse();
  }
  return credentialsNotConfiguredResponse();
}

export async function fetchWithAuth(ctx: ServerContext, url: string, init: RequestInit): Promise<Response> {
  const makeRequest = async () => {
    const token = await signJWT(ctx);
    return fetchWithTimeout(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
    });
  };

  const response = await makeRequest();
  // Retry once on 401 — the JWT may have been issued just before clock skew threshold
  if (response.status === 401) {
    return makeRequest();
  }
  return response;
}
