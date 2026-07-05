// apps/mcp-server/src/tools/handlers.ts
//
// The seven tool-call handlers + the approval long-poll. Extracted from
// index.ts during the modularization (Critique-Roadmap prompt 06.4). Each
// takes the ServerContext explicitly (config + server) instead of reaching for
// module globals. Behavior is unchanged — pinned by test/introspection.test.ts.

import {
  errorContent,
  jsonContent,
  tryParseJson,
  safeJsonParse,
  sleep,
  diagnoseNetworkError,
  fetchWithTimeout,
} from "../net.js";
import { requireCredentials, fetchWithAuth } from "../auth.js";
import type { ServerContext } from "../context.js";
import type { AllowedMethod } from "./schemas.js";

export async function handleListPlatforms(ctx: ServerContext) {
  const gate = await requireCredentials(ctx);
  if (gate) return gate;

  let response: Response;
  try {
    response = await fetchWithAuth(ctx, `${ctx.PROXY_URL}/v1/agent/permissions`, { method: "GET", headers: {} });
  } catch (err) {
    return errorContent(diagnoseNetworkError(err, ctx.PROXY_URL));
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

// Long-poll budget — under Claude Desktop's hardcoded 60s tool timeout
// (with 10s of safety). After this we return a graceful "queued" message and
// the action lands in the user's pending-actions list (Layer 4).
const APPROVAL_POLL_BUDGET_MS = 50_000;
const APPROVAL_POLL_INTERVAL_MS = 2_000;
const APPROVAL_PROGRESS_INTERVAL_MS = 5_000;

export async function handleUsePlatform(
  ctx: ServerContext,
  params: {
    platform: string;
    endpoint: string;
    method: AllowedMethod;
    scope: string;
    data?: Record<string, unknown>;
    connection_id?: string;
  },
  progressToken?: string | number,
) {
  const gate = await requireCredentials(ctx);
  if (gate) return gate;

  // Observe Mode: when a BYO credential is configured locally, route to the
  // audit-only relay and attach the credential as a header (NEVER in the body —
  // it must not enter model-visible tool args). Governed behaviour is unchanged
  // when no observe credential is set.
  //
  // Platform-match guard: if OBSERVE_PLATFORM is set, only route to the observe
  // relay when the requested platform matches — preventing BYO credential leakage
  // to unrelated platforms. If OBSERVE_PLATFORM is empty, route observe for any
  // platform (backwards-compat when only OBSERVE_CREDENTIAL is set).
  const observePlatformMatch =
    ctx.OBSERVE_CREDENTIAL &&
    (ctx.OBSERVE_PLATFORM === "" || ctx.OBSERVE_PLATFORM === params.platform);

  if (observePlatformMatch) {
    const observeBody = {
      platform: params.platform,
      endpoint: params.endpoint,
      method: params.method,
      action: params.scope,
      ...(params.data !== undefined && { body: params.data }),
    };
    let response: Response;
    try {
      // fetchWithAuth signs and attaches the AV agent JWT (Authorization: Bearer …).
      // Content-Type: application/json is added by fetchWithAuth before spreading
      // init.headers, so X-AV-Observe-Credential survives.
      response = await fetchWithAuth(ctx, `${ctx.PROXY_URL}/v1/observe/actions`, {
        method: "POST",
        headers: { "X-AV-Observe-Credential": ctx.OBSERVE_CREDENTIAL },
        body: JSON.stringify(observeBody),
      });
    } catch (err) {
      return errorContent(`Network error: ${err instanceof Error ? err.message : err}`);
    }
    const text = await response.text();
    if (!response.ok) return errorContent(`Proxy error ${response.status}: ${text}`);
    return jsonContent(text);
  }

  const requestBody = {
    platform: params.platform,
    endpoint: params.endpoint,
    method: params.method,
    scope: params.scope,
    ...(params.data !== undefined && { data: params.data }),
    ...(params.connection_id ? { connection_id: params.connection_id } : {}),
  };

  let response: Response;
  try {
    response = await fetchWithAuth(ctx, `${ctx.PROXY_URL}/v1/actions`, {
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
      return await waitForApproval(ctx, approvalId, params, progressToken);
    }
  }

  if (!response.ok) {
    // 403 is the access-denied / scope-not-granted code returned by the
    // proxy's authorize pipeline (see apps/proxy/src/pipeline/authorize.ts).
    // Point the agent at request_platform_access instead of dead-ending it.
    const hint =
      response.status === 403
        ? "  You can call request_platform_access({ platform, scope, reason }) to ask an org admin to grant this."
        : "";
    return errorContent(`Proxy error ${response.status}: ${body}${hint}`);
  }
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
  ctx: ServerContext,
  approvalId: string,
  originalCall: { platform: string; scope: string; endpoint: string },
  progressToken?: string | number,
) {
  const startedAt = Date.now();
  let lastProgressAt = 0;

  // Initial progress so the user sees activity immediately.
  await sendProgress(ctx, progressToken, 0, APPROVAL_POLL_BUDGET_MS,
    `Owner approval required for ${originalCall.platform}:${originalCall.scope} — waiting…`);

  while (Date.now() - startedAt < APPROVAL_POLL_BUDGET_MS) {
    await sleep(APPROVAL_POLL_INTERVAL_MS);
    const elapsed = Date.now() - startedAt;

    let res: Response;
    try {
      res = await fetchWithAuth(ctx, `${ctx.PROXY_URL}/v1/approvals/${approvalId}`, { method: "GET" });
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
      await sendProgress(ctx, progressToken, elapsed, APPROVAL_POLL_BUDGET_MS,
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

async function sendProgress(
  ctx: ServerContext,
  token: string | number | undefined,
  progress: number,
  total: number,
  message: string,
): Promise<void> {
  if (token === undefined) return;
  try {
    await ctx.server.notification({
      method: "notifications/progress",
      params: { progressToken: token, progress, total, message },
    });
  } catch {
    // Best-effort — never let a failed notification break the call.
  }
}

export async function handleAgentRegister(ctx: ServerContext, args: Record<string, unknown>) {
  let response: Response;
  try {
    response = await fetchWithTimeout(`${ctx.PROXY_URL}/v1/register`, {
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

export async function handleAgentStatus(ctx: ServerContext, token: string) {
  let response: Response;
  try {
    response = await fetchWithTimeout(`${ctx.PROXY_URL}/v1/register/status/${encodeURIComponent(token)}`, {
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

export async function handleAuthzenEvaluate(ctx: ServerContext, platformId: string, scope: string) {
  const gate = await requireCredentials(ctx);
  if (gate) return gate;

  const authzenBody = {
    subject: { type: "agent", id: ctx.AGENT_ID },
    action: { name: "tool_call" },
    resource: { type: "platform_scope", id: `${platformId}:${scope}` },
  };

  let response: Response;
  try {
    response = await fetchWithAuth(ctx, `${ctx.PROXY_URL}/v1/authzen/access`, {
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

export async function handleListMyPendingActions(ctx: ServerContext) {
  const gate = await requireCredentials(ctx);
  if (gate) return gate;

  let response: Response;
  try {
    response = await fetchWithAuth(ctx, `${ctx.PROXY_URL}/v1/agents/me/pending-actions`, { method: "GET" });
  } catch (err) {
    return errorContent(`Network error: ${err instanceof Error ? err.message : err}`);
  }

  const text = await response.text();
  if (!response.ok) return errorContent(`Proxy error ${response.status}: ${text}`);
  return jsonContent(text);
}

export async function handleRequestPlatformAccess(ctx: ServerContext, args: Record<string, unknown>) {
  const gate = await requireCredentials(ctx);
  if (gate) return gate;

  const platform = typeof args.platform === "string" ? args.platform : "";
  if (!platform) return errorContent("platform is required");
  const scope = typeof args.scope === "string" ? args.scope : undefined;
  const reason = typeof args.reason === "string" ? args.reason : undefined;

  let submit: Response;
  try {
    submit = await fetchWithAuth(ctx, `${ctx.PROXY_URL}/v1/access-request`, {
      method: "POST",
      body: JSON.stringify({ platform, scope, reason }),
    });
  } catch (err) {
    return errorContent(diagnoseNetworkError(err, ctx.PROXY_URL));
  }
  if (!submit.ok && submit.status !== 202 && submit.status !== 200) {
    const t = await submit.text();
    return errorContent(`Access request failed (${submit.status}): ${t}`);
  }
  const submitted = (await submit.json()) as { request_token?: string };
  const token = submitted.request_token;
  if (!token) return errorContent("Access request did not return a token.");

  // Poll the request status for ~50s (2s interval), matching use_platform UX.
  const deadline = Date.now() + 50_000;
  while (Date.now() < deadline) {
    await sleep(2000);
    let statusRes: Response;
    try {
      statusRes = await fetchWithAuth(
        ctx,
        `${ctx.PROXY_URL}/v1/access-request/status/${encodeURIComponent(token)}`,
        { method: "GET" },
      );
    } catch {
      continue;
    }
    if (!statusRes.ok) continue;
    const s = (await statusRes.json()) as { status?: string };
    if (s.status === "approved") {
      return jsonContent(
        JSON.stringify({ status: "approved", message: "Access granted — retry your original use_platform call." }),
      );
    }
    if (s.status === "denied") {
      return jsonContent(JSON.stringify({ status: "denied", message: "An admin denied this access request." }));
    }
  }
  return jsonContent(
    JSON.stringify({
      status: "pending",
      message: "Request submitted and awaiting admin approval. Retry your call later.",
    }),
  );
}

export async function handleReportSelfDiagnostic(ctx: ServerContext, args: Record<string, unknown>) {
  const gate = await requireCredentials(ctx);
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
    response = await fetchWithAuth(ctx, `${ctx.PROXY_URL}/v1/agents/self/diagnostics`, {
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
