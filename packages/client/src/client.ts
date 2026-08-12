// packages/client/src/client.ts
//
// The AgentValet client. This is the non-MCP path: a developer writing their
// own agent (LangChain, a cron job, a plain Node service) gets the same
// governance guarantees the MCP server provides — signed agent identity,
// deny-by-default scope enforcement, the owner-approval long-poll, and the
// audit record — without hand-rolling RS256 JWTs against /v1/actions.
//
// Deliberate parity with apps/mcp-server: same endpoints, same 50s approval
// budget, same 2s poll interval, same one-shot 401 retry. If these drift, an
// operator debugging the SDK can no longer reason from the MCP server's
// behaviour (and vice versa).

import { SignJWT, importPKCS8 } from "jose";
import type { KeyLike } from "jose";
import {
  AccessDeniedError,
  ApprovalDeniedError,
  ApprovalExpiredError,
  ApprovalTimeoutError,
  ConfigError,
  ProxyError,
  UpstreamError,
} from "./errors.js";
import { diagnoseNetworkError, fetchWithTimeout, sleep, tryParseJson, type FetchLike } from "./http.js";
import {
  DEFAULT_PROXY_URL,
  agentIdFromEnv,
  ownerIdFromEnv,
  privateKeyFromEnv,
  proxyUrlFromEnv,
} from "./env.js";

/** Matches the mcp-server's budget: under Claude Desktop's 60s tool timeout. */
const DEFAULT_APPROVAL_TIMEOUT_MS = 50_000;
const DEFAULT_APPROVAL_POLL_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export interface AgentValetOptions {
  agentId: string;
  ownerId: string;
  /** RS256 private key, PEM (PKCS#8). */
  privateKey: string;
  /** Defaults to https://api.agentvalet.ai. */
  proxyUrl?: string;
  /** Per-request network timeout. Default 15s. */
  timeoutMs?: number;
  /**
   * How long `call()` waits on an owner approval before throwing
   * ApprovalTimeoutError. Default 50s. Set 0 to never wait — `call()` then
   * throws immediately with the approval_id for you to resume later.
   */
  approvalTimeoutMs?: number;
  /** Approval poll interval. Default 2s. */
  approvalPollMs?: number;
  /** Injectable for tests / custom agents. Defaults to global fetch. */
  fetch?: FetchLike;
  /** Called roughly every poll while an approval is outstanding. */
  onApprovalPending?: (info: {
    approvalId: string;
    elapsedMs: number;
    platform: string;
    scope: string;
    endpoint: string;
  }) => void;
}

export interface CallRequest {
  platform: string;
  endpoint: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  scope: string;
  data?: unknown;
  /** Pick a specific connection when the platform has several. */
  connectionId?: string;
  /** Justification shown to the approver. Normalized and capped server-side. */
  reason?: string;
  /** Overrides the client-level approval budget for this one call. */
  approvalTimeoutMs?: number;
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

export class AgentValet {
  readonly agentId: string;
  readonly ownerId: string;
  readonly proxyUrl: string;
  private readonly privateKeyPem: string;
  private readonly timeoutMs: number;
  private readonly approvalTimeoutMs: number;
  private readonly approvalPollMs: number;
  private readonly doFetch: FetchLike;
  private readonly onApprovalPending?: AgentValetOptions["onApprovalPending"];
  private importedKey: KeyLike | null = null;

  constructor(opts: AgentValetOptions) {
    if (!opts.agentId) throw new ConfigError("agentId is required");
    if (!opts.ownerId) throw new ConfigError("ownerId is required");
    if (!opts.privateKey) throw new ConfigError("privateKey is required");

    this.agentId = opts.agentId;
    this.ownerId = opts.ownerId;
    this.privateKeyPem = opts.privateKey;
    this.proxyUrl = (opts.proxyUrl ?? DEFAULT_PROXY_URL).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.approvalPollMs = opts.approvalPollMs ?? DEFAULT_APPROVAL_POLL_MS;
    this.doFetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.onApprovalPending = opts.onApprovalPending;
  }

  /**
   * Builds a client from the environment. Works out of the box on a machine
   * that has run `npx @agentvalet/register`. See env.ts for the accepted names.
   */
  static fromEnv(overrides: Partial<AgentValetOptions> = {}): AgentValet {
    const agentId = overrides.agentId ?? agentIdFromEnv();
    const ownerId = overrides.ownerId ?? ownerIdFromEnv();
    if (!agentId || !ownerId) {
      throw new ConfigError(
        "AgentValet identity not found in the environment. Set AGENTVALET_AGENT_ID and " +
          "AGENTVALET_OWNER_ID (or AGENT_ID / OWNER_ID), or run `npx @agentvalet/register`.",
      );
    }
    return new AgentValet({
      ...overrides,
      agentId,
      ownerId,
      privateKey: overrides.privateKey ?? privateKeyFromEnv(),
      proxyUrl: overrides.proxyUrl ?? proxyUrlFromEnv(),
    });
  }

  // ---- core ---------------------------------------------------------------

  /**
   * Calls an approved platform through the broker. Returns the upstream SaaS
   * response body, parsed.
   *
   * If the owner must approve, this blocks for up to `approvalTimeoutMs` and
   * then returns the result transparently — from the caller's point of view an
   * approved call just took longer. If nobody approves in time it throws
   * ApprovalTimeoutError, whose `approvalId` you can resume with
   * `waitForApproval()`; the action stays queued server-side either way.
   */
  async call<T = unknown>(req: CallRequest): Promise<T> {
    const body = {
      platform: req.platform,
      endpoint: req.endpoint,
      method: req.method ?? "GET",
      scope: req.scope,
      ...(req.data !== undefined && { data: req.data }),
      ...(req.connectionId ? { connection_id: req.connectionId } : {}),
      ...(req.reason ? { reason: req.reason } : {}),
    };

    const res = await this.authedFetch("/v1/actions", { method: "POST", body: JSON.stringify(body) });
    const text = await res.text();

    // 202 + approval_id → the owner needs to approve. Enter the long-poll.
    if (res.status === 202) {
      const approvalId = (tryParseJson(text) as { approval_id?: string } | undefined)?.approval_id;
      if (approvalId) {
        return (await this.waitForApproval<T>(approvalId, {
          platform: req.platform,
          scope: req.scope,
          endpoint: req.endpoint,
          timeoutMs: req.approvalTimeoutMs ?? this.approvalTimeoutMs,
        })) as T;
      }
    }

    if (!res.ok) {
      // 403 is the proxy's authorize-pipeline denial (no grant, or policy
      // blocked). Surface it as its own type so callers can branch into
      // requestAccess() instead of dead-ending on a generic failure.
      if (res.status === 403) {
        throw new AccessDeniedError(res.status, text, req.platform, req.scope);
      }
      throw new ProxyError(res.status, text);
    }

    return (tryParseJson(text) ?? text) as T;
  }

  /**
   * Resumes waiting on an outstanding approval. Use with the `approvalId` from
   * a caught ApprovalTimeoutError — the action is queued server-side, so this
   * picks up exactly where `call()` left off.
   */
  async waitForApproval<T = unknown>(
    approvalId: string,
    ctx: { platform?: string; scope?: string; endpoint?: string; timeoutMs?: number } = {},
  ): Promise<T> {
    const budget = ctx.timeoutMs ?? this.approvalTimeoutMs;
    const startedAt = Date.now();

    while (Date.now() - startedAt < budget) {
      await sleep(this.approvalPollMs);
      const elapsed = Date.now() - startedAt;

      let res: Response;
      try {
        res = await this.authedFetch(`/v1/approvals/${encodeURIComponent(approvalId)}`, { method: "GET" });
      } catch {
        continue; // transient — try again next tick
      }

      if (!res.ok) throw new ProxyError(res.status, await res.text());

      const status = (await res.json()) as ApprovalStatusResponse;

      if (status.status === "denied") {
        throw new ApprovalDeniedError(approvalId, status.execution_error);
      }
      if (status.status === "expired") {
        throw new ApprovalExpiredError(approvalId);
      }
      if (status.execution_error) {
        // Approved, but the re-execution failed (upstream down, agent revoked).
        throw new ProxyError(502, `Approved but re-execution failed: ${status.execution_error}`);
      }
      if (status.status === "approved" && status.executed_at && status.result) {
        const r = status.result;
        if (r.status < 200 || r.status >= 300) throw new UpstreamError(r.status, r.data);
        return r.data as T;
      }

      this.onApprovalPending?.({
        approvalId,
        elapsedMs: elapsed,
        platform: ctx.platform ?? "",
        scope: ctx.scope ?? "",
        endpoint: ctx.endpoint ?? "",
      });
    }

    throw new ApprovalTimeoutError(approvalId, budget);
  }

  // ---- discovery / governance --------------------------------------------

  /** Platforms and scopes this agent is actually granted. Deny-by-default: if
   *  it isn't here, `call()` will 403. */
  async listPlatforms<T = unknown>(): Promise<T> {
    return this.getJson<T>("/v1/agent/permissions");
  }

  /** Actions queued behind an owner approval that haven't resolved yet. */
  async pendingActions<T = unknown>(): Promise<T> {
    return this.getJson<T>("/v1/agents/me/pending-actions");
  }

  /**
   * Dry-run an authorization decision without performing the action. Cheap way
   * to check a destructive scope before committing to a side effect.
   */
  async evaluate<T = unknown>(platform: string, scope: string): Promise<T> {
    const res = await this.authedFetch("/v1/authzen/access", {
      method: "POST",
      body: JSON.stringify({
        subject: { type: "agent", id: this.agentId },
        action: { name: "tool_call" },
        resource: { type: "platform_scope", id: `${platform}:${scope}` },
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new ProxyError(res.status, text);
    return (tryParseJson(text) ?? text) as T;
  }

  /**
   * Asks an org admin to grant platform+scope, then polls for the decision.
   * Resolves "approved" | "denied" | "pending" — on "approved", retry the
   * original `call()`.
   */
  async requestAccess(
    req: { platform: string; scope?: string; reason?: string; timeoutMs?: number },
  ): Promise<{ status: "approved" | "denied" | "pending"; requestToken: string }> {
    const submit = await this.authedFetch("/v1/access-request", {
      method: "POST",
      body: JSON.stringify({ platform: req.platform, scope: req.scope, reason: req.reason }),
    });
    if (!submit.ok && submit.status !== 202) {
      throw new ProxyError(submit.status, await submit.text());
    }
    const { request_token: token } = (await submit.json()) as { request_token?: string };
    if (!token) throw new ProxyError(submit.status, "Access request did not return a request_token.");

    const deadline = Date.now() + (req.timeoutMs ?? this.approvalTimeoutMs);
    while (Date.now() < deadline) {
      await sleep(this.approvalPollMs);
      let res: Response;
      try {
        res = await this.authedFetch(`/v1/access-request/status/${encodeURIComponent(token)}`, { method: "GET" });
      } catch {
        continue;
      }
      if (!res.ok) continue;
      const s = (await res.json()) as { status?: string };
      if (s.status === "approved") return { status: "approved", requestToken: token };
      if (s.status === "denied") return { status: "denied", requestToken: token };
    }
    return { status: "pending", requestToken: token };
  }

  // ---- transport ----------------------------------------------------------

  /** Signs a short-lived (60s) RS256 assertion of this agent's identity. */
  async signJWT(): Promise<string> {
    if (!this.importedKey) {
      try {
        this.importedKey = await importPKCS8(this.privateKeyPem, "RS256");
      } catch (err) {
        throw new ConfigError(
          `Private key is not a valid PKCS#8 RS256 PEM: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    return new SignJWT({ agent_id: this.agentId, owner_id: this.ownerId })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(this.importedKey);
  }

  private async authedFetch(path: string, init: RequestInit): Promise<Response> {
    const url = `${this.proxyUrl}${path}`;
    const once = async () => {
      const token = await this.signJWT();
      try {
        return await fetchWithTimeout(
          this.doFetch,
          url,
          {
            ...init,
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
          },
          this.timeoutMs,
        );
      } catch (err) {
        throw diagnoseNetworkError(err, this.proxyUrl);
      }
    };

    const res = await once();
    // Retry once on 401 — the JWT may have been minted either side of a clock
    // skew boundary. Same one-shot retry the mcp-server does.
    return res.status === 401 ? once() : res;
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.authedFetch(path, { method: "GET" });
    const text = await res.text();
    if (!res.ok) throw new ProxyError(res.status, text);
    return (tryParseJson(text) ?? text) as T;
  }
}
