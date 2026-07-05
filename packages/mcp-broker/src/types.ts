// The public API surface of @agentvalet/mcp-broker.
//
// Four interfaces are the open and paid seam: PolicySource, SecretSource,
// ApprovalProvider, AuditSink. The local implementations shipped here are the
// free tier; the hosted implementations (agentvalet:) are simply the best
// implementations of the same contracts. Their shapes never change between the
// two, so a server author can move from local to hosted without touching a
// handler.

// The minimal slice of the MCP SDK's per-request context the broker reads. Kept
// structural so the broker does not hard-depend on the SDK's exact type; the
// SDK is a peer dependency, provided by the server author.
export interface McpHandlerExtra {
  sessionId?: string;
  requestId?: string | number;
  signal?: AbortSignal;
  authInfo?: {
    clientId?: string;
    scopes?: string[];
    extra?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

// AuthZEN-shaped by design so the authzen: policy source is a thin adapter and
// interop with an external PDP is a one-pager, not a rewrite.
export interface AccessRequest {
  subject: { id: string; spiffeId?: string; sessionId: string };
  action: { name: string };
  resource: { server: string; tool: string };
  context: { argsFingerprint: string; transport: string; ts: string };
}

export type Effect = "allow" | "deny" | "require_approval";

// Obligations are the documented extensibility point on a Decision. The broker
// ships two concrete kinds and ignores any it does not recognise, so a richer
// hosted plane can add obligations without breaking a local handler.
//   - credential: which vault reference to resolve for this call.
//   - narrow_scope: the scope the resolved credential must be narrowed to.
export type Obligation =
  | { type: "credential"; ref: string; scope?: string[] }
  | { type: "narrow_scope"; scope: string[] }
  | { type: string; [key: string]: unknown };

export interface Decision {
  effect: Effect;
  obligations?: Obligation[];
  policyId: string;
  version: string;
}

export interface CredentialRef {
  id: string;
  scope?: string[];
}

// What a handler receives as ctx.credential. Never the raw ref, never a token
// broader than the call needs.
export interface Credential {
  token: string;
  expiresAt?: Date;
  scope?: string[];
}

export interface ApprovalResult {
  approved: boolean;
  // "timeout" | "denied" | free text from the provider.
  reason?: string;
}

export type Outcome =
  | "allowed"
  | "denied"
  | "approval_timeout"
  | "approval_denied"
  | "handler_error";

// Stable, versioned audit schema. Carries an args fingerprint, never raw args.
// Field names follow OTel-ish semantic conventions where they exist.
export interface AuditEvent {
  schemaVersion: 1;
  ts: string;
  subject: { id: string; sessionId: string; spiffeId?: string };
  resource: { server: string; tool: string };
  action: string;
  argsFingerprint: string;
  decision: { effect: Effect; policyId: string; version: string };
  credentialScope?: string[];
  transport: string;
  latencyMs: number;
  outcome: Outcome;
  warnings?: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// The four pluggable interfaces.
// ---------------------------------------------------------------------------

export interface PolicySource {
  evaluate(req: AccessRequest): Promise<Decision>;
}

export interface SecretSource {
  // MUST honour scope narrowing from decision.obligations. The hosted impl
  // mints short-lived scoped tokens; the env impl passes the token through and
  // records an expiry warning in the audit event.
  resolve(ref: CredentialRef, decision: Decision): Promise<Credential>;
}

export interface ApprovalProvider {
  request(req: AccessRequest, decision: Decision): Promise<ApprovalResult>;
}

export interface AuditSink {
  emit(event: AuditEvent): Promise<void>;
}

export interface IdentityResolver {
  resolve(extra: McpHandlerExtra): AccessRequest["subject"];
}

// Post-call response filter. No-op by default. The full response-side PII
// redaction is a hosted feature; this is only the seam for it.
export type RedactionHook = (
  response: unknown,
  ctx: { decision: Decision },
) => unknown | Promise<unknown>;

export interface BrokerOptions {
  policy: PolicySource | string;
  secrets: SecretSource | string;
  audit?: AuditSink | string;
  approval?: ApprovalProvider;
  identity?: IdentityResolver;
  redact?: RedactionHook;
  // Default "closed". A policy source that is unreachable means deny. "open"
  // exists for dev loops only and logs loudly on every request.
  failMode?: "closed" | "open";
}

// What the broker injects onto the handler's context: ctx.credential is the
// resolved, narrow secret for this call only.
export type ToolContext = McpHandlerExtra & { credential?: Credential };
