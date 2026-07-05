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
import { validateConfig } from "./config.js";
import { renderInstructions } from "./instructions.js";
import type { ServerContext } from "./context.js";
import { signJWT } from "./auth.js";
import { ALLOWED_METHODS, ALL_TOOLS, type AllowedMethod } from "./tools/schemas.js";
import {
  handleListPlatforms,
  handleUsePlatform,
  handleAgentRegister,
  handleAgentStatus,
  handleAuthzenEvaluate,
  handleListMyPendingActions,
  handleReportSelfDiagnostic,
  handleRequestPlatformAccess,
} from "./tools/handlers.js";
import { errorContent } from "./net.js";

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
// MCP server setup
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "agentvalet", version: "1.0.0" },
  { capabilities: { tools: {} }, instructions: renderInstructions(undefined) }
);

// The config + server bundle threaded into auth + handlers (see context.ts) —
// keeps those modules free of globals.
const ctx: ServerContext = {
  AGENT_ID,
  OWNER_ID,
  PROXY_URL,
  AGENT_PRIVATE_KEY_RAW,
  privateKey,
  server,
  OBSERVE_PLATFORM: process.env.OBSERVE_PLATFORM ?? "",
  OBSERVE_CREDENTIAL: process.env.OBSERVE_CREDENTIAL ?? "",
};

// Boot-time platform fetch — primes the proxy connection and surfaces auth
// failures in the stderr boot diagnostics. Best-effort and fire-and-forget so
// it can NEVER delay the `initialize` response (a top-level await here used to
// block Claude Desktop for seconds on cold Azure CA and cause host timeouts).
// The host LLM learns the catalogue from list_platforms at runtime.
void (async () => {
  if (AGENT_PRIVATE_KEY_RAW === null) return;
  try {
    const token = await signJWT(ctx);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 4_000);
    await fetch(`${PROXY_URL}/v1/agent/permissions`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      signal: ac.signal,
    }).finally(() => clearTimeout(timer));
  } catch {
    // best-effort warmup only
  }
})().catch(() => {});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ALL_TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "list_platforms") {
    return await handleListPlatforms(ctx);
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
    return await handleUsePlatform(ctx, {
      platform: args.platform,
      endpoint: args.endpoint,
      method: args.method as AllowedMethod,
      scope: args.scope,
      data: bodyArg,
      ...(typeof args.connection_id === "string" ? { connection_id: args.connection_id } : {}),
    }, progressToken);
  }

  if (name === "agent_register") {
    if (!args || typeof args.owner_id !== "string" || typeof args.agent_name !== "string" || !Array.isArray(args.requested_scopes)) {
      return errorContent("Invalid or missing arguments: owner_id, agent_name, requested_scopes are required");
    }
    return await handleAgentRegister(ctx, args as Record<string, unknown>);
  }

  if (name === "agent_status") {
    if (!args || typeof args.token !== "string") {
      return errorContent("Invalid or missing argument: token is required");
    }
    return await handleAgentStatus(ctx, args.token);
  }

  if (name === "authzen_evaluate") {
    if (!args || typeof args.platform_id !== "string" || typeof args.scope !== "string") {
      return errorContent("Invalid or missing arguments: platform_id and scope are required");
    }
    return await handleAuthzenEvaluate(ctx, args.platform_id, args.scope);
  }

  if (name === "list_my_pending_actions") {
    return await handleListMyPendingActions(ctx);
  }

  if (name === "report_self_diagnostic") {
    if (!args || typeof args.severity !== "string" || typeof args.message !== "string") {
      return errorContent("Invalid or missing arguments: severity and message are required");
    }
    return await handleReportSelfDiagnostic(ctx, args as Record<string, unknown>);
  }

  if (name === "request_platform_access") {
    if (!args || typeof args.platform !== "string") {
      return errorContent("Invalid or missing argument: platform is required");
    }
    return await handleRequestPlatformAccess(ctx, args as Record<string, unknown>);
  }

  return {
    content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

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
