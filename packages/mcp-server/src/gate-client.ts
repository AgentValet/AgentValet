// apps/mcp-server/src/gate-client.ts
//
// A thin, dependency-free client over AgentValet's public governance contract.
// It does NOT implement policy, brokering, or audit. Those live in the proxy.
// It only does two things:
//
//   1. Send a request to the public gate (POST /v1/actions) or the Observe
//      relay (POST /v1/observe/actions).
//   2. Map the wire response to exactly one of the six documented decisions, so
//      a connector switches on a single discriminated union instead of
//      re-deriving status-code semantics in every integration.
//
// The full wire contract these mappings depend on is documented in
// docs/contract/public-governance-gate.md. Keep this file and that doc in step.
//
// fetch is injectable (fetchImpl) so the mapping is testable without a network;
// it defaults to the global fetch.

/** The six terminal decisions a gate call can resolve to. */
export type GateDecision =
  | "allowed"
  | "denied"
  | "pending_approval"
  | "error"
  | "suspended"
  | "observed";

export interface GateAllowed {
  decision: "allowed";
  status: number;
  /** Upstream response body, already unwrapped by the proxy. */
  data: unknown;
}

export interface GateDenied {
  decision: "denied";
  status: number;
  /** Machine reason when the proxy supplied one (e.g. scope_not_granted, no_credential). */
  reason: string | null;
  correlationId?: string;
  raw: unknown;
}

export interface GatePendingApproval {
  decision: "pending_approval";
  status: number;
  /** Poll /v1/approvals/<id> for the outcome, or surface it to the owner. */
  approvalId: string | null;
  message?: string;
  raw: unknown;
}

export interface GateError {
  decision: "error";
  status: number;
  /** Machine code when present (reauth_failed, platform_misconfigured, network_error, ...). */
  code: string | null;
  correlationId?: string;
  raw: unknown;
}

export interface GateSuspended {
  decision: "suspended";
  status: number;
  /** agent_suspended | circuit_breaker_open */
  reason: string;
  raw: unknown;
}

export interface GateObserved {
  decision: "observed";
  /** The upstream status the Observe relay passed through. */
  status: number;
  data: unknown;
}

export type GateOutcome =
  | GateAllowed
  | GateDenied
  | GatePendingApproval
  | GateError
  | GateSuspended;

export interface GateClient {
  proxyUrl: string;
  /** A signed agent JWT (RS256). The wrapper does not mint or refresh it. */
  token: string;
  fetchImpl?: typeof fetch;
}

export interface GateRequest {
  platform: string;
  endpoint: string;
  method: string;
  scope: string;
  data?: unknown;
  connection_id?: string;
}

export interface ObserveRequest {
  platform: string;
  endpoint: string;
  method: string;
  action?: string;
  body?: unknown;
  /** BYO credential. Sent as a header only; never enters the request body. */
  credential: string;
}

/** Agent states that mean "the agent itself is halted", surfaced as a 403 by the
 *  permission check. Distinct from a policy denial of an otherwise-healthy agent. */
const SUSPENDED_REASONS = new Set(["agent_suspended", "circuit_breaker_open"]);

function readField(body: unknown, key: string): string | undefined {
  if (body && typeof body === "object" && key in body) {
    const v = (body as Record<string, unknown>)[key];
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

/**
 * Pure mapper: a public-gate response (HTTP status + parsed body) to a decision.
 * Exported so connectors and tests can classify a response they already hold.
 *
 * Mapping (POST /v1/actions):
 *   2xx                                  -> allowed
 *   202                                  -> pending_approval
 *   403 reason in {agent_suspended,
 *        circuit_breaker_open}           -> suspended
 *   401 / 5xx                            -> error
 *   other 4xx (402/403/412/429/...)      -> denied
 */
export function classifyGateResponse(status: number, body: unknown): GateOutcome {
  if (status === 202) {
    return {
      decision: "pending_approval",
      status,
      approvalId: readField(body, "approval_id") ?? null,
      message: readField(body, "message"),
      raw: body,
    };
  }

  if (status >= 200 && status < 300) {
    return { decision: "allowed", status, data: body };
  }

  if (status === 403) {
    const reason = readField(body, "reason");
    if (reason && SUSPENDED_REASONS.has(reason)) {
      return { decision: "suspended", status, reason, raw: body };
    }
  }

  // Identity rejection and upstream/server failures are not policy decisions.
  if (status === 401 || status >= 500) {
    return {
      decision: "error",
      status,
      code: readField(body, "code") ?? (status === 401 ? "unauthorized" : null),
      correlationId: readField(body, "correlation_id"),
      raw: body,
    };
  }

  // Every other 4xx (402 billing, 403 policy, 412 not-connected, 429 rate) is a
  // governance refusal of an otherwise-healthy agent.
  return {
    decision: "denied",
    status,
    reason: readField(body, "reason") ?? readField(body, "error") ?? null,
    correlationId: readField(body, "correlation_id"),
    raw: body,
  };
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Call the public governance gate (POST /v1/actions) and return a classified
 * outcome. Never throws for a gate response or a transport failure: a transport
 * failure resolves to a GateError with code "network_error" so callers handle
 * every path through the same switch.
 */
export async function callGate(client: GateClient, req: GateRequest): Promise<GateOutcome> {
  const doFetch = client.fetchImpl ?? fetch;
  const requestBody = {
    platform: req.platform,
    endpoint: req.endpoint,
    method: req.method,
    scope: req.scope,
    ...(req.data !== undefined ? { data: req.data } : {}),
    ...(req.connection_id ? { connection_id: req.connection_id } : {}),
  };

  let res: Response;
  try {
    res = await doFetch(`${client.proxyUrl}/v1/actions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${client.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    return {
      decision: "error",
      status: 0,
      code: "network_error",
      raw: { error: err instanceof Error ? err.message : String(err) },
    };
  }

  return classifyGateResponse(res.status, await parseBody(res));
}

/**
 * Call the Observe relay (POST /v1/observe/actions). The relay is audit-only and
 * passes the upstream status through, so a completed relay always resolves to
 * GateObserved regardless of the upstream status. The BYO credential rides as a
 * header and never enters the request body. A transport failure resolves to a
 * GateError with code "network_error".
 */
export async function observe(
  client: GateClient,
  req: ObserveRequest,
): Promise<GateObserved | GateError> {
  const doFetch = client.fetchImpl ?? fetch;
  const relayBody = {
    platform: req.platform,
    endpoint: req.endpoint,
    method: req.method,
    ...(req.action !== undefined ? { action: req.action } : {}),
    ...(req.body !== undefined ? { body: req.body } : {}),
  };

  let res: Response;
  try {
    res = await doFetch(`${client.proxyUrl}/v1/observe/actions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${client.token}`,
        "Content-Type": "application/json",
        "X-AV-Observe-Credential": req.credential,
      },
      body: JSON.stringify(relayBody),
    });
  } catch (err) {
    return {
      decision: "error",
      status: 0,
      code: "network_error",
      raw: { error: err instanceof Error ? err.message : String(err) },
    };
  }

  return { decision: "observed", status: res.status, data: await parseBody(res) };
}
