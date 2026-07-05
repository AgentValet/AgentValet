// apps/mcp-server/src/tools/schemas.ts
//
// MCP tool definitions (name + description + input/output JSON schema). Pure
// data — extracted verbatim from index.ts during the modularization
// (Critique-Roadmap prompt 06.4). The tool SURFACE is contract-pinned by
// test/introspection.test.ts, so any accidental change here fails CI.

export const ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type AllowedMethod = typeof ALLOWED_METHODS[number];

export const LIST_PLATFORMS_TOOL = {
  name: "list_platforms",
  description: "list_platforms: List the platforms and permission scopes this agent has access to.\nInput: None.\nReturns: { platforms: [{ platformId, platformName, scopes, requireApproval, connections? }], version: \"<hex>\" }. A platform includes `connections` only when it has 2+ usable accounts; pass the chosen connection_id to use_platform (omit for the default).\nVersion: a deterministic hash that only changes when the platform set or scopes change. Cache the value across calls in the same session — only refresh when you suspect platforms have changed (e.g. user mentions a new connection).\nAuth: Bearer JWT.",
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
            connections: {
              type: "array",
              description: "Present only when this platform has 2+ usable connections (e.g. two GitHub orgs). Pass the chosen connection_id to use_platform; omit to use the default connection.",
              items: {
                type: "object",
                properties: {
                  connection_id: { type: "string" },
                  label:         { type: "string" },
                  is_default:    { type: "boolean" },
                  scopes:        { type: "array", items: { type: "string" } },
                },
                required: ["connection_id", "label"],
              },
            },
          },
          required: ["platformId", "platformName", "scopes"],
        },
      },
      version: { type: "string" },
    },
    required: ["platforms"],
  },
};

export const USE_PLATFORM_TOOL = {
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
      connection_id: {
        type: "string",
        description: "Optional. Target a specific connection when a platform has more than one connected (e.g. two GitHub orgs). Value is the connection id shown in the dashboard. Omit to use the default connection.",
      },
    },
    required: ["platform", "endpoint", "method", "scope"],
  },
};

export const AGENT_REGISTER_TOOL = {
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

export const AGENT_STATUS_TOOL = {
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

export const AUTHZEN_EVALUATE_TOOL = {
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

export const REPORT_SELF_DIAGNOSTIC_TOOL = {
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

export const LIST_MY_PENDING_ACTIONS_TOOL = {
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

export const REQUEST_PLATFORM_ACCESS_TOOL = {
  name: "request_platform_access",
  description:
    "request_platform_access: Ask an org admin to grant this agent access to a platform it is currently blocked from. Call this when use_platform returns an access-denied error. Input: platform (string, required), scope (string, optional — the specific scope you need), reason (string, optional — why you need it). The call waits up to ~50s for an admin decision. Returns: { status: \"approved\"|\"pending\"|\"denied\", message }. On \"approved\", retry your original use_platform call. On \"pending\", the request is queued; retry later. Auth: Bearer agent JWT (sent automatically).",
  inputSchema: {
    type: "object" as const,
    properties: {
      platform: { type: "string", description: "Platform ID (e.g. github, slack)" },
      scope: { type: "string", description: "Optional specific scope needed (e.g. repo:read)" },
      reason: { type: "string", description: "Optional short reason for the request" },
    },
    required: ["platform"],
  },
  outputSchema: {
    type: "object" as const,
    properties: {
      status: { type: "string", enum: ["approved", "pending", "denied"] },
      message: { type: "string" },
    },
    required: ["status"],
  },
};

export const ALL_TOOLS = [
  LIST_PLATFORMS_TOOL,
  USE_PLATFORM_TOOL,
  AGENT_REGISTER_TOOL,
  AGENT_STATUS_TOOL,
  AUTHZEN_EVALUATE_TOOL,
  REPORT_SELF_DIAGNOSTIC_TOOL,
  LIST_MY_PENDING_ACTIONS_TOOL,
  REQUEST_PLATFORM_ACCESS_TOOL,
];
