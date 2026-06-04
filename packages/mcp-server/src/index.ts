#!/usr/bin/env node
// ── BOOT DIAGNOSTICS — must be FIRST executable code ─────────────────────
// Claude Desktop captures whatever the MCP server writes to stderr before
// the stdio transport handshake. If startup crashes silently (top-level
// await rejection, import error, unhandled native crash), Claude Desktop
// only logs "Server transport closed unexpectedly" with no detail. These
// handlers guarantee a stack lands in the log no matter what fails next.
process.stderr.write(
  `[mcp-server] boot v0.2.x | node=${process.version} | platform=${process.platform} | ` +
    `env_keys=${Object.keys(process.env).filter((k) => k.startsWith("AGENT_") || k === "OWNER_ID" || k === "PROXY_URL" || k === "INVITE_BIND_SECRET").join(",") || "(none of expected)"}\n`,
);
process.on("uncaughtException", (err) => {
  process.stderr.write(
    `[mcp-server] FATAL uncaughtException: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  process.stderr.write(
    `[mcp-server] FATAL unhandledRejection: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { SignJWT } from "jose";
import { validateConfig } from "./config.js";
import { renderInstructions } from "./instructions.js";

// ---------------------------------------------------------------------------
// Startup env validation
// ---------------------------------------------------------------------------

let configResult: Awaited<ReturnType<typeof validateConfig>>;
try {
  configResult = await validateConfig();
} catch (err) {
  process.stderr.write(
    `[mcp-server] FATAL validateConfig threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
}
const { agentId: AGENT_ID, ownerId: OWNER_ID, proxyUrl: PROXY_URL, privateKeyPem: AGENT_PRIVATE_KEY_RAW, privateKey } = configResult;
process.stderr.write(
  `[mcp-server] config ok | agent=${AGENT_ID} | owner=${OWNER_ID} | proxy=${PROXY_URL} | has_key=${!!privateKey}\n`,
);

// ---------------------------------------------------------------------------
// JWT signing
// ---------------------------------------------------------------------------

async function signJWT(): Promise<string> {
  if (!privateKey) throw new Error("Private key not loaded");
  return new SignJWT({ agent_id: AGENT_ID, owner_id: OWNER_ID })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(privateKey);
}

async function notifyBindSecret() {
  try {
    await fetchWithTimeout(
      `${PROXY_URL}/v1/bind-secret`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: AGENT_ID, owner_id: OWNER_ID }),
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
async function requireCredentials() {
  if (AGENT_PRIVATE_KEY_RAW !== null) return null;
  if (AGENT_ID && OWNER_ID) {
    await notifyBindSecret();
    return pendingFirstCallResponse();
  }
  return credentialsNotConfiguredResponse();
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type AllowedMethod = typeof ALLOWED_METHODS[number];

const LIST_PLATFORMS_TOOL = {
  name: "list_platforms",
  description: "list_platforms: List the platforms and permission scopes this agent has access to.\nInput: None.\nReturns: { platforms: [{ platformId, platformName, scopes, requireApproval }], version: \"<hex>\" }.\nVersion: a deterministic hash that only changes when the platform set or scopes change. Cache the value across calls in the same session — only refresh when you suspect platforms have changed (e.g. user mentions a new connection).\nAuth: Bearer JWT.",
  inputSchema: { type: "object" as const, properties: {} },
  outputSchema: {
    type: "object" as const,
    properties: {
      platforms: {
        type: "array",
        items: {
          type: "object",
          properties: {
            platformId:      { type: "string" },
            platformName:    { type: "string" },
            scopes:          { type: "array", items: { type: "string" } },
            requireApproval: { type: "boolean" },
          },
          required: ["platformId", "platformName", "scopes"],
        },
      },
      version: { type: "string" },
    },
    required: ["platforms"],
  },
};

const USE_PLATFORM_TOOL = {
  name: "use_platform",
  description:
    "use_platform: Call an external platform API (Airtable, GitHub, Slack, Metabase, etc.) through the AgentValet proxy.\nInput: platform (string), endpoint (string), method (GET|POST|PUT|PATCH|DELETE), scope (string), body (object, optional — JSON request body for POST/PUT/PATCH/DELETE).\nReturns: upstream API response body. May take up to 50 seconds when the action requires owner approval — the call will block while we wait, then return the approved result transparently. If approval doesn't land in time, returns a `pending_approval` envelope and the action runs asynchronously; the user is notified when it completes.\nAuth: Bearer JWT.\nNote: legacy clients passing `data` instead of `body` are still accepted for backwards compatibility, but `body` is the canonical name.",
  inputSchema: {
    type: "object" as const,
    properties: {
      platform: {
        type: "string",
        description: "Platform ID (e.g. airtable, github, slack, metabase)",
      },
      endpoint: {
        type: "string",
        description: "API path on the target platform (e.g. /v0/meta/bases or /api/dataset)",
      },
      method: {
        type: "string",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
        description: "HTTP method to use",
      },
      scope: {
        type: "string",
        description: "Permission scope required for this action (e.g. records:read)",
      },
      body: {
        type: "object",
        description: "JSON request body for POST/PUT/PATCH/DELETE. Optional. Forwarded verbatim to the upstream API.",
      },
      data: {
        type: "object",
        description: "Deprecated alias for `body` — prefer `body`. Kept for backwards compatibility.",
      },
    },
    required: ["platform", "endpoint", "method", "scope"],
  },
};

const AGENT_REGISTER_TOOL = {
  name: "agent_register",
  description:
    "agent_register: Self-register this agent with an owner. No auth required.\nInput: owner_id (string), agent_name (string), requested_scopes (array of {platformId, scopes}).\nReturns: registration_token, poll_url, client_id, scope, expires_in.\nAuth: None.",
  inputSchema: {
    type: "object" as const,
    properties: {
      owner_id: {
        type: "string",
        description: "The owner ID to register this agent under",
      },
      agent_name: {
        type: "string",
        description: "Human-readable name for this agent",
      },
      requested_scopes: {
        type: "array",
        description: "Array of platform scope requests",
        items: {
          type: "object",
          properties: {
            platformId: { type: "string" },
            scopes: { type: "array", items: { type: "string" } },
          },
          required: ["platformId", "scopes"],
        },
      },
    },
    required: ["owner_id", "agent_name", "requested_scopes"],
  },
  outputSchema: {
    type: "object" as const,
    properties: {
      registration_token: { type: "string" },
      poll_url:           { type: "string" },
      client_id:          { type: "string" },
      scope:              { type: "string" },
      expires_in:         { type: "number" },
    },
    required: ["registration_token"],
  },
};

const AGENT_STATUS_TOOL = {
  name: "agent_status",
  description:
    "agent_status: Poll registration status using the token from agent_register.\nInput: token (string, required).\nReturns: status (\"pending_approval\"|\"approved\"|\"rejected\"), agent_id (if approved), mcp_config (if approved).\nAuth: None.",
  inputSchema: {
    type: "object" as const,
    properties: {
      token: {
        type: "string",
        description: "Registration token returned by agent_register",
      },
    },
    required: ["token"],
  },
  outputSchema: {
    type: "object" as const,
    properties: {
      status:     { type: "string", enum: ["pending_approval", "approved", "rejected"] },
      agent_id:   { type: "string" },
      mcp_config: { type: "object" },
    },
    required: ["status"],
  },
};

const AUTHZEN_EVALUATE_TOOL = {
  name: "authzen_evaluate",
  description:
    "authzen_evaluate: Evaluate whether this agent has access to a specific platform scope. Call this BEFORE use_platform when you want to pre-check without making the upstream call.\nInput: platform_id (string), scope (string).\nReturns: decision (boolean), reason (\"approved\"|\"denied\"|\"revoked\"|\"scope_not_granted\").\nAuth: Bearer agent JWT (sent automatically by this MCP server).",
  inputSchema: {
    type: "object" as const,
    properties: {
      platform_id: {
        type: "string",
        description: "The platform identifier (e.g. airtable, github)",
      },
      scope: {
        type: "string",
        description: "The permission scope to evaluate (e.g. records:read)",
      },
    },
    required: ["platform_id", "scope"],
  },
  outputSchema: {
    type: "object" as const,
    properties: {
      decision: { type: "boolean" },
      context:  { type: "object", properties: { reason: { type: "string" } } },
    },
    required: ["decision"],
  },
};

const REPORT_SELF_DIAGNOSTIC_TOOL = {
  name: "report_self_diagnostic",
  description:
    "report_self_diagnostic: Lodge a self-report (error/warning/info) with the AgentValet owner. Use after a use_platform error returns a report_hint, OR proactively when you encounter a problem the user should know about.\nInput: severity (debug|info|warn|error|critical), message (string, required, max 4096 bytes), code (string, optional, max 128 chars), platform (string, optional), endpoint (string, optional), correlation_id (uuid string, optional — copy from the failing call's report_hint to stitch this report to the broker-side audit row), context (object, optional, JSON-serialised must be < 16 KiB).\nReturns: { id, received_at } on success.\nAuth: Bearer agent JWT (sent automatically).",
  inputSchema: {
    type: "object" as const,
    properties: {
      severity: {
        type: "string",
        enum: ["debug", "info", "warn", "error", "critical"],
        description: "Severity level. error/critical trigger an owner notification.",
      },
      message: {
        type: "string",
        description: "One-sentence agent narrative describing what happened.",
      },
      code: {
        type: "string",
        description: "Optional short machine code (e.g. 'permission_denied').",
      },
      platform: {
        type: "string",
        description: "Optional platform id this report relates to.",
      },
      endpoint: {
        type: "string",
        description: "Optional endpoint that failed.",
      },
      correlation_id: {
        type: "string",
        description: "Optional UUID — copy from a use_platform error's report_hint to stitch this report to the audit row.",
      },
      context: {
        type: "object",
        description: "Optional structured context (request params, error details). Avoid secrets.",
      },
    },
    required: ["severity", "message"],
  },
  outputSchema: {
    type: "object" as const,
    properties: {
      id:          { type: "string" },
      received_at: { type: "string" },
    },
    required: ["id"],
  },
};

const LIST_MY_PENDING_ACTIONS_TOOL = {
  name: "list_my_pending_actions",
  description:
    "list_my_pending_actions: Returns this agent's currently-pending approval requests AND any that completed in the last 24 hours. Use this at session start when the user mentions an earlier action, or when use_platform's long-poll timed out and the user comes back asking what happened.\nInput: None.\nReturns: { pending: [{approval_id, platform_id, scope, created_at, expires_at}], recently_completed: [{approval_id, platform_id, scope, status, executed_at, result_summary, execution_error}] }.\nAuth: Bearer agent JWT (sent automatically).",
  inputSchema: { type: "object" as const, properties: {} },
  outputSchema: {
    type: "object" as const,
    properties: {
      pending: {
        type: "array",
        items: {
          type: "object",
          properties: {
            approval_id: { type: "string" },
            platform_id: { type: "string" },
            scope:       { type: "string" },
            created_at:  { type: "string" },
            expires_at:  { type: "string" },
          },
          required: ["approval_id", "platform_id", "scope"],
        },
      },
      recently_completed: {
        type: "array",
        items: {
          type: "object",
          properties: {
            approval_id:     { type: "string" },
            platform_id:     { type: "string" },
            scope:           { type: "string" },
            status:          { type: "string" },
            executed_at:     { type: "string" },
            result_summary:  { type: "string" },
            execution_error: { type: "string" },
          },
          required: ["approval_id", "status"],
        },
      },
    },
    required: ["pending", "recently_completed"],
  },
};

// TODO: intent_resolve tool — planned for future release

// ---------------------------------------------------------------------------
// Boot-time platform fetch — primes the instruction block with the live
// platform list so the host LLM sees an exact catalogue. Best-effort: if the
// fetch fails (agent not activated, network down), we fall back to the static
// instructions and rely on the agent calling list_platforms at runtime.
// ---------------------------------------------------------------------------

async function fetchPlatformNamesForInstructions(): Promise<string[] | undefined> {
  if (AGENT_PRIVATE_KEY_RAW === null) return undefined;
  try {
    const token = await signJWT();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 4_000);
    const res = await fetch(`${PROXY_URL}/v1/agent/permissions`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      signal: ac.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return undefined;
    const body = (await res.json()) as { platforms?: Array<{ platformName?: string; platformId?: string }> };
    const names = (body.platforms ?? [])
      .map((p) => p.platformName ?? p.platformId)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
    return names.length > 0 ? names : undefined;
  } catch {
    return undefined;
  }
}

// NOTE: We intentionally do NOT prefetch platform names at boot. Doing so
// added a top-level await on the proxy and blocked the `initialize` response
// to Claude Desktop for several seconds (worse on cold Azure CA), causing
// host-side timeouts. The LLM learns the catalogue from list_platforms at
// runtime — boot-time enrichment was nice-to-have, not load-bearing.

// ---------------------------------------------------------------------------
// MCP server setup
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "agentvalet", version: "1.0.0" },
  { capabilities: { tools: {} }, instructions: renderInstructions(undefined) }
);

// Fire the platform-names fetch in the background after the server is up so
// it can't delay initialize. The result isn't surfaced to the host (MCP has
// no instructions-update message), but the network warmup primes the proxy
// and surfaces auth failures in the stderr boot diagnostics path.
void fetchPlatformNamesForInstructions().catch(() => {});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    LIST_PLATFORMS_TOOL,
    USE_PLATFORM_TOOL,
    AGENT_REGISTER_TOOL,
    AGENT_STATUS_TOOL,
    AUTHZEN_EVALUATE_TOOL,
    REPORT_SELF_DIAGNOSTIC_TOOL,
    LIST_MY_PENDING_ACTIONS_TOOL,
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "list_platforms") {
    return await handleListPlatforms();
  }

  if (name === "use_platform") {
    if (
      !args ||
      typeof args.platform !== "string" ||
      typeof args.endpoint !== "string" ||
      typeof args.method !== "string" ||
      typeof args.scope !== "string"
    ) {
      return {
        content: [{ type: "text" as const, text: "Invalid or missing tool arguments" }],
        isError: true,
      };
    }
    if (!ALLOWED_METHODS.includes(args.method as AllowedMethod)) {
      return {
        content: [{ type: "text" as const, text: `Invalid method: ${args.method}` }],
        isError: true,
      };
    }
    const progressToken = (request.params._meta as { progressToken?: string | number } | undefined)?.progressToken;
    // Accept either `body` (canonical) or `data` (legacy alias). `body` wins
    // when both are supplied. This matters because Claude (and other LLM
    // hosts) reach for `body` as the natural HTTP terminology — the prior
    // schema only declared `data` which made every POST get silently
    // dropped to an empty body. See the use_platform tool description.
    const bodyArg = (args.body ?? args.data) as Record<string, unknown> | undefined;
    return await handleUsePlatform({
      platform: args.platform,
      endpoint: args.endpoint,
      method: args.method as AllowedMethod,
      scope: args.scope,
      data: bodyArg,
    }, progressToken);
  }

  if (name === "agent_register") {
    if (!args || typeof args.owner_id !== "string" || typeof args.agent_name !== "string" || !Array.isArray(args.requested_scopes)) {
      return errorContent("Invalid or missing arguments: owner_id, agent_name, requested_scopes are required");
    }
    return await handleAgentRegister(args as Record<string, unknown>);
  }

  if (name === "agent_status") {
    if (!args || typeof args.token !== "string") {
      return errorContent("Invalid or missing argument: token is required");
    }
    return await handleAgentStatus(args.token);
  }

  if (name === "authzen_evaluate") {
    if (!args || typeof args.platform_id !== "string" || typeof args.scope !== "string") {
      return errorContent("Invalid or missing arguments: platform_id and scope are required");
    }
    return await handleAuthzenEvaluate(args.platform_id, args.scope);
  }

  if (name === "list_my_pending_actions") {
    return await handleListMyPendingActions();
  }

  if (name === "report_self_diagnostic") {
    if (!args || typeof args.severity !== "string" || typeof args.message !== "string") {
      return errorContent("Invalid or missing arguments: severity and message are required");
    }
    return await handleReportSelfDiagnostic(args as Record<string, unknown>);
  }

  return {
    content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 15_000): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  return fetch(url, { ...init, signal: ac.signal }).finally(() => clearTimeout(timer));
}

async function fetchWithAuth(url: string, init: RequestInit): Promise<Response> {
  const makeRequest = async () => {
    const token = await signJWT();
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

function errorContent(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

// Return helper that gives an MCP-aware host the structured content directly
// (no parse step), while still emitting the text-content envelope every MCP
// client understands. Avoids the "list of length 1 with empty fields → let me
// parse the wrapper" round-trip Claude does on tool results that are raw
// JSON strings — every read-heavy use_platform call pays that cost otherwise.
//
// If `body` isn't valid JSON, we just return the text envelope unchanged —
// callers that emit prose (summaries, error strings) get the old behaviour.
function jsonContent(body: string) {
  const parsed = tryParseJson(body);
  if (parsed === undefined) {
    return { content: [{ type: "text" as const, text: body }] };
  }
  return {
    content: [{ type: "text" as const, text: body }],
    structuredContent: parsed as Record<string, unknown>,
  };
}

function tryParseJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  // Only attempt parse if it looks structured. Avoids parsing a stray "true"
  // / number / etc. into structuredContent and confusing the host.
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    const v = JSON.parse(trimmed);
    if (v && typeof v === "object") return v;
    return undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleListPlatforms() {
  const gate = await requireCredentials();
  if (gate) return gate;

  let response: Response;
  try {
    response = await fetchWithAuth(`${PROXY_URL}/v1/agent/permissions`, { method: "GET", headers: {} });
  } catch (err) {
    return errorContent(diagnoseNetworkError(err, PROXY_URL));
  }

  const body = await response.text();
  if (!response.ok) return errorContent(`Proxy error ${response.status}: ${body}`);

  // Proxy wraps the payload as { data: { platforms, version }, _meta: {...} }
  // but outputSchema declares the flat { platforms, version } shape, so the
  // wrapped envelope fails strict structuredContent validation and the host
  // surfaces "tool execution failed (no upstream body)". Unwrap .data.
  const parsed = tryParseJson(body);
  const inner =
    parsed && typeof parsed === "object" && parsed !== null && "data" in parsed
      ? (parsed as { data: unknown }).data
      : parsed;
  if (inner && typeof inner === "object") {
    return {
      content: [{ type: "text" as const, text: body }],
      structuredContent: inner as Record<string, unknown>,
    };
  }
  return jsonContent(body);
}

// Translates a fetch() failure into something an end-user can actually act on.
// The default "Network error: fetch failed" message tells a non-developer
// nothing. Look at the underlying cause keyword and map to a concrete fix.
function diagnoseNetworkError(err: unknown, proxyUrl: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  // Node's undici surfaces DNS failures as "getaddrinfo ENOTFOUND <host>".
  if (lower.includes("enotfound") || lower.includes("getaddrinfo")) {
    return `Network error: cannot resolve ${proxyUrl}. Check your DNS / corporate proxy / VPN, or confirm the PROXY_URL setting is correct. Raw: ${raw}`;
  }
  // Connection refused / unreachable / TLS handshake failure.
  if (lower.includes("econnrefused") || lower.includes("econnreset")) {
    return `Network error: connection to ${proxyUrl} was refused or reset. The proxy may be down — check https://status.agentvalet.ai — or a firewall is blocking the request. Raw: ${raw}`;
  }
  if (lower.includes("etimedout") || lower.includes("timeout") || lower.includes("aborterror")) {
    return `Network error: request to ${proxyUrl} timed out. Likely causes: VPN routing, corporate proxy buffering, or slow network. Try again or confirm api.agentvalet.ai is reachable from this machine. Raw: ${raw}`;
  }
  if (lower.includes("self signed") || lower.includes("cert") || lower.includes("ssl") || lower.includes("tls")) {
    return `Network error: TLS / certificate problem talking to ${proxyUrl}. A corporate MITM proxy may be intercepting traffic. Raw: ${raw}`;
  }
  return `Network error reaching ${proxyUrl}: ${raw}. Check VPN, corporate proxy, and firewall rules for api.agentvalet.ai. If the proxy itself is down, see https://status.agentvalet.ai.`;
}

// Long-poll budget — under Claude Desktop's hardcoded 60s tool timeout
// (with 10s of safety). After this we return a graceful "queued" message and
// the action lands in the user's pending-actions list (Layer 4).
const APPROVAL_POLL_BUDGET_MS = 50_000;
const APPROVAL_POLL_INTERVAL_MS = 2_000;
const APPROVAL_PROGRESS_INTERVAL_MS = 5_000;

async function handleUsePlatform(
  params: {
    platform: string;
    endpoint: string;
    method: AllowedMethod;
    scope: string;
    data?: Record<string, unknown>;
  },
  progressToken?: string | number,
) {
  const gate = await requireCredentials();
  if (gate) return gate;

  const requestBody = {
    platform: params.platform,
    endpoint: params.endpoint,
    method: params.method,
    scope: params.scope,
    ...(params.data !== undefined && { data: params.data }),
  };

  let response: Response;
  try {
    response = await fetchWithAuth(`${PROXY_URL}/v1/actions`, {
      method: "POST",
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    return errorContent(`Network error: ${err instanceof Error ? err.message : err}`);
  }

  const body = await response.text();

  // 202 + approval_id → enter long-poll. The proxy returns this when the
  // owner needs to approve the call. We poll /v1/approvals/:id every ~2s
  // for up to 50s; if the owner approves in time the proxy re-runs the
  // upstream call and we return its result to the agent transparently.
  if (response.status === 202) {
    const parsed = safeJsonParse(body);
    const approvalId: string | undefined = parsed?.approval_id;
    if (approvalId) {
      return await waitForApproval(approvalId, params, progressToken);
    }
  }

  if (!response.ok) return errorContent(`Proxy error ${response.status}: ${body}`);
  return jsonContent(body);
}

interface ApprovalStatusResponse {
  approval_id: string;
  status: "pending" | "approved" | "denied" | "expired";
  result?: { status: number; data: unknown };
  execution_error?: string;
  expires_at: string;
  executed_at: string | null;
  created_at: string;
}

async function waitForApproval(
  approvalId: string,
  originalCall: { platform: string; scope: string; endpoint: string },
  progressToken?: string | number,
) {
  const startedAt = Date.now();
  let lastProgressAt = 0;

  // Initial progress so the user sees activity immediately.
  await sendProgress(progressToken, 0, APPROVAL_POLL_BUDGET_MS,
    `Owner approval required for ${originalCall.platform}:${originalCall.scope} — waiting…`);

  while (Date.now() - startedAt < APPROVAL_POLL_BUDGET_MS) {
    await sleep(APPROVAL_POLL_INTERVAL_MS);
    const elapsed = Date.now() - startedAt;

    let res: Response;
    try {
      res = await fetchWithAuth(`${PROXY_URL}/v1/approvals/${approvalId}`, { method: "GET" });
    } catch {
      // Transient network error — try again next tick.
      continue;
    }

    if (!res.ok) {
      // 404/410 etc. — treat as terminal. Surface back to the agent.
      const text = await res.text();
      return errorContent(`Approval status error ${res.status}: ${text}`);
    }

    const status = (await res.json()) as ApprovalStatusResponse;

    if (status.status === "approved" && status.executed_at && status.result) {
      // Re-execution complete. Return the upstream response transparently —
      // the agent sees this as if the original use_platform call just succeeded.
      const r = status.result;
      // Mirror the non-2xx-from-upstream behaviour of the regular path.
      if (r.status < 200 || r.status >= 300) {
        return errorContent(`Upstream returned ${r.status}: ${JSON.stringify(r.data)}`);
      }
      // Two-channel return: the text envelope carries the human-readable
      // "[Owner approved after Ns]" prefix (visible to non-structured-aware
      // clients), and structuredContent carries the parsed upstream JSON
      // directly so MCP-aware hosts (Claude Desktop ≥ MCP spec 2025-06-18)
      // never have to strip-the-prefix-and-reparse. Without the second
      // channel the prefix forces Claude into the same wrapper-parse
      // round-trip the bare /v1/actions path used to.
      const data = r.data ?? null;
      const summary = `[Owner approved after ${Math.round(elapsed / 1000)}s]\n` +
                      JSON.stringify(data);
      const result: { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown> } = {
        content: [{ type: "text" as const, text: summary }],
      };
      if (data && typeof data === "object" && !Array.isArray(data)) {
        result.structuredContent = data as Record<string, unknown>;
      }
      return result;
    }

    if (status.status === "denied") {
      return errorContent(
        `Owner denied this action${status.execution_error ? `: ${status.execution_error}` : "."}`,
      );
    }

    if (status.status === "expired") {
      return errorContent("Approval request expired before the owner responded.");
    }

    if (status.execution_error) {
      // Approved but re-execution failed (network / upstream / agent revoked).
      return errorContent(`Approved but re-execution failed: ${status.execution_error}`);
    }

    // Still pending — emit a progress update at most once per ~5s so the
    // user can see the wait advancing in the Claude Desktop tool UI.
    if (Date.now() - lastProgressAt >= APPROVAL_PROGRESS_INTERVAL_MS) {
      await sendProgress(progressToken, elapsed, APPROVAL_POLL_BUDGET_MS,
        `Waiting for owner approval — ${Math.round(elapsed / 1000)}s elapsed`);
      lastProgressAt = Date.now();
    }
  }

  // Timed out — fall through to async-recap path. The action is still
  // queued and will run when the owner approves; the user is notified via
  // push/email at that point. Layer 4's list_my_pending_actions surfaces it.
  return jsonContent(JSON.stringify({
    status: "pending_approval",
    approval_id: approvalId,
    message:
      `Owner hasn't approved within ${APPROVAL_POLL_BUDGET_MS / 1000}s. ` +
      `The action is queued — your owner will be notified, and you'll see it ` +
      `complete next time we chat (or you can ask me to check pending actions).`,
  }));
}

function safeJsonParse(text: string): { approval_id?: string } | null {
  try { return JSON.parse(text); } catch { return null; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendProgress(
  token: string | number | undefined,
  progress: number,
  total: number,
  message: string,
): Promise<void> {
  if (token === undefined) return;
  try {
    await server.notification({
      method: "notifications/progress",
      params: { progressToken: token, progress, total, message },
    });
  } catch {
    // Best-effort — never let a failed notification break the call.
  }
}

async function handleAgentRegister(args: Record<string, unknown>) {
  let response: Response;
  try {
    response = await fetchWithTimeout(`${PROXY_URL}/v1/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
  } catch (err) {
    return errorContent(`Network error: ${err instanceof Error ? err.message : err}`);
  }

  const body = await response.text();
  if (!response.ok) return errorContent(`Proxy error ${response.status}: ${body}`);
  return jsonContent(body);
}

async function handleAgentStatus(token: string) {
  let response: Response;
  try {
    response = await fetchWithTimeout(`${PROXY_URL}/v1/register/status/${encodeURIComponent(token)}`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return errorContent(`Network error: ${err instanceof Error ? err.message : err}`);
  }

  const body = await response.text();
  if (!response.ok) return errorContent(`Proxy error ${response.status}: ${body}`);
  return jsonContent(body);
}

async function handleAuthzenEvaluate(platformId: string, scope: string) {
  const gate = await requireCredentials();
  if (gate) return gate;

  const authzenBody = {
    subject: { type: "agent", id: AGENT_ID },
    action: { name: "tool_call" },
    resource: { type: "platform_scope", id: `${platformId}:${scope}` },
  };

  let response: Response;
  try {
    response = await fetchWithAuth(`${PROXY_URL}/v1/authzen/access`, {
      method: "POST",
      body: JSON.stringify(authzenBody),
    });
  } catch (err) {
    return errorContent(`Network error: ${err instanceof Error ? err.message : err}`);
  }

  const body = await response.text();
  if (!response.ok) return errorContent(`Proxy error ${response.status}: ${body}`);
  return jsonContent(body);
}

async function handleListMyPendingActions() {
  const gate = await requireCredentials();
  if (gate) return gate;

  let response: Response;
  try {
    response = await fetchWithAuth(`${PROXY_URL}/v1/agents/me/pending-actions`, { method: "GET" });
  } catch (err) {
    return errorContent(`Network error: ${err instanceof Error ? err.message : err}`);
  }

  const text = await response.text();
  if (!response.ok) return errorContent(`Proxy error ${response.status}: ${text}`);
  return jsonContent(text);
}

async function handleReportSelfDiagnostic(args: Record<string, unknown>) {
  const gate = await requireCredentials();
  if (gate) return gate;

  // Whitelist body fields — never forward owner_id/agent_id (proxy derives those from JWT).
  const body: Record<string, unknown> = {
    severity: args.severity,
    message: args.message,
  };
  for (const k of ["code", "platform", "endpoint", "correlation_id", "context"] as const) {
    if (args[k] !== undefined) body[k] = args[k];
  }

  let response: Response;
  try {
    response = await fetchWithAuth(`${PROXY_URL}/v1/agents/self/diagnostics`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch (err) {
    return errorContent(`Network error: ${err instanceof Error ? err.message : err}`);
  }

  const text = await response.text();
  if (!response.ok) return errorContent(`Proxy error ${response.status}: ${text}`);
  return jsonContent(text);
}

// ---------------------------------------------------------------------------
// Connect transport
// ---------------------------------------------------------------------------

if (process.env.MCP_TRANSPORT === "http") {
  const { startHttpTransport } = await import("./transports/http.js");
  const port = parseInt(process.env.MCP_PORT ?? "3100", 10);
  await startHttpTransport(server, port);
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
