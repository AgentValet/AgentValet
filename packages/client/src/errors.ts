// packages/client/src/errors.ts
//
// Typed error hierarchy. The whole point of the SDK over raw /v1/actions is
// that a caller can branch on WHY a call failed without string-matching the
// proxy's error envelope. Every throw from the client is one of these.

export class AgentValetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Missing/!malformed identity or key — thrown before any network call. */
export class ConfigError extends AgentValetError {}

/** fetch() itself failed. `.hint` carries an actionable diagnosis. */
export class NetworkError extends AgentValetError {
  constructor(message: string, readonly cause: unknown) {
    super(message);
  }
}

/** Non-2xx from the AgentValet proxy that isn't a more specific case below. */
export class ProxyError extends AgentValetError {
  constructor(readonly status: number, readonly body: string) {
    super(`Proxy error ${status}: ${body}`);
  }
}

/**
 * 403 — the agent has no grant for this platform+scope, or policy blocked it.
 * Recoverable: call `requestAccess({ platform, scope, reason })`.
 */
export class AccessDeniedError extends ProxyError {
  constructor(status: number, body: string, readonly platform: string, readonly scope: string) {
    super(status, body);
    this.message =
      `Access denied for ${platform}:${scope} — ${body}. ` +
      `Call requestAccess({ platform, scope, reason }) to ask an org admin to grant it.`;
  }
}

/** The owner explicitly denied the action. Terminal — do not retry. */
export class ApprovalDeniedError extends AgentValetError {
  constructor(readonly approvalId: string, detail?: string) {
    super(`Owner denied this action${detail ? `: ${detail}` : "."}`);
  }
}

/** The approval request aged out server-side before anyone responded. */
export class ApprovalExpiredError extends AgentValetError {
  constructor(readonly approvalId: string) {
    super("Approval request expired before the owner responded.");
  }
}

/**
 * We stopped waiting, but the action is still queued server-side and will run
 * if the owner approves. NOT a failure — hold `approvalId` and resume later
 * with `client.waitForApproval(approvalId)`.
 */
export class ApprovalTimeoutError extends AgentValetError {
  constructor(readonly approvalId: string, waitedMs: number) {
    super(
      `Owner hasn't approved within ${Math.round(waitedMs / 1000)}s. The action is still queued — ` +
        `keep approval_id ${approvalId} and call waitForApproval(approvalId) to resume.`,
    );
  }
}

/** Approved and executed, but the upstream SaaS returned a non-2xx. */
export class UpstreamError extends AgentValetError {
  constructor(readonly status: number, readonly data: unknown) {
    super(`Upstream returned ${status}: ${JSON.stringify(data)}`);
  }
}
