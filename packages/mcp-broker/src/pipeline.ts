// The enforcement pipeline. One pass per tool call:
//
//   resolve identity -> evaluate policy -> (approval if required) ->
//   resolve credential -> invoke handler -> redact -> audit
//
// Every terminating outcome (allow, deny, approval timeout/denial, handler
// error) emits exactly one conformant AuditEvent carrying an args fingerprint
// and never the raw arguments. The pipeline is transport-agnostic: it hands the
// resolved credential to an injected invoker and returns a small tagged result
// the caller turns into an MCP response.
import { argsFingerprint } from "./fingerprint.js";
import type {
  AccessRequest,
  AuditEvent,
  AuditSink,
  ApprovalProvider,
  Credential,
  Decision,
  IdentityResolver,
  McpHandlerExtra,
  Obligation,
  Outcome,
  PolicySource,
  RedactionHook,
  SecretSource,
} from "./types.js";

export interface PipelineDeps {
  serverName: string;
  policy: PolicySource;
  secrets: SecretSource;
  audit: AuditSink;
  identity: IdentityResolver;
  approval?: ApprovalProvider;
  redact?: RedactionHook;
  failMode: "closed" | "open";
  // Loud logger used only when failMode is "open". Defaults to console.warn.
  warn?: (message: string) => void;
  now?: () => number;
  clock?: () => Date;
}

export type PipelineResult =
  | { status: "ok"; result: unknown }
  | { status: "blocked"; effect: Decision["effect"]; reason: string };

function credentialObligation(decision: Decision): Extract<Obligation, { type: "credential" }> | undefined {
  return (decision.obligations ?? []).find((o) => o.type === "credential") as
    | Extract<Obligation, { type: "credential" }>
    | undefined;
}

export async function runPipeline(
  deps: PipelineDeps,
  params: { toolName: string; args: unknown; extra: McpHandlerExtra },
  invoke: (credential: Credential | undefined) => Promise<unknown>,
): Promise<PipelineResult> {
  const now = deps.now ?? (() => Date.now());
  const clock = deps.clock ?? (() => new Date());
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const started = now();

  const subject = deps.identity.resolve(params.extra);
  const transport = params.extra.requestInfo ? "http" : "stdio";
  const fp = argsFingerprint(params.args);
  const req: AccessRequest = {
    subject,
    action: { name: params.toolName },
    resource: { server: deps.serverName, tool: params.toolName },
    context: { argsFingerprint: fp, transport, ts: clock().toISOString() },
  };

  const warnings: string[] = [];

  const emit = async (
    outcome: Outcome,
    decision: Decision,
    extra: { credentialScope?: string[]; error?: string } = {},
  ): Promise<void> => {
    const event: AuditEvent = {
      schemaVersion: 1,
      ts: clock().toISOString(),
      subject,
      resource: req.resource,
      action: params.toolName,
      argsFingerprint: fp,
      decision: { effect: decision.effect, policyId: decision.policyId, version: decision.version },
      transport,
      latencyMs: now() - started,
      outcome,
      ...(extra.credentialScope ? { credentialScope: extra.credentialScope } : {}),
      ...(warnings.length ? { warnings: [...warnings] } : {}),
      ...(extra.error ? { error: extra.error } : {}),
    };
    // Audit is best-effort at the sink boundary: a failing sink (e.g. a hosted
    // ingest that is briefly unreachable) must never change or break the
    // authorization outcome. It logs loudly instead.
    try {
      await deps.audit.emit(event);
    } catch (err) {
      warn(`[mcp-broker] audit sink failed for "${params.toolName}": ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // 1. Evaluate policy. Fail closed on an unreachable/broken source.
  let decision: Decision;
  try {
    decision = await deps.policy.evaluate(req);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const failDecision: Decision = { effect: "deny", policyId: "unavailable", version: "0" };
    if (deps.failMode === "open") {
      warn(`[mcp-broker] failMode=open: policy source unreachable, ALLOWING "${params.toolName}" (${reason}). This is unsafe outside a dev loop.`);
      warnings.push(`failMode_open_policy_unreachable: ${reason}`);
      decision = { effect: "allow", policyId: "unavailable", version: "0" };
    } else {
      warnings.push(`policy_source_unreachable: ${reason}`);
      await emit("denied", failDecision);
      return { status: "blocked", effect: "deny", reason: "policy source unreachable" };
    }
  }

  // 2. Deny short-circuits.
  if (decision.effect === "deny") {
    await emit("denied", decision);
    return { status: "blocked", effect: "deny", reason: "denied by policy" };
  }

  // 3. Approval, if required.
  if (decision.effect === "require_approval") {
    if (!deps.approval) {
      warnings.push("require_approval_without_provider");
      await emit("approval_denied", decision);
      return { status: "blocked", effect: "require_approval", reason: "approval required but no approval provider is configured" };
    }
    let approved = false;
    let approvalReason: string | undefined;
    try {
      const result = await deps.approval.request(req, decision);
      approved = result.approved;
      approvalReason = result.reason;
    } catch (err) {
      approvalReason = err instanceof Error ? err.message : String(err);
    }
    if (!approved) {
      const outcome: Outcome = approvalReason === "timeout" ? "approval_timeout" : "approval_denied";
      if (approvalReason) warnings.push(`approval_${approvalReason}`);
      await emit(outcome, decision);
      return { status: "blocked", effect: "require_approval", reason: `approval ${approvalReason ?? "not granted"}` };
    }
  }

  // 4. Resolve the credential (if the decision names one). Failure denies.
  let credential: Credential | undefined;
  const credOb = credentialObligation(decision);
  if (credOb) {
    try {
      credential = await deps.secrets.resolve(
        credOb.scope ? { id: credOb.ref, scope: credOb.scope } : { id: credOb.ref },
        decision,
      );
    } catch (err) {
      warnings.push(`credential_unresolved: ${err instanceof Error ? err.message : String(err)}`);
      await emit("denied", decision);
      return { status: "blocked", effect: "deny", reason: "credential could not be resolved" };
    }
    if (!credential.expiresAt) {
      warnings.push("credential_no_expiry_static_secret");
    }
  }

  // 5. Invoke the author's handler with the narrow credential injected.
  let result: unknown;
  try {
    result = await invoke(credential);
  } catch (err) {
    await emit("handler_error", decision, {
      credentialScope: credential?.scope,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  // 6. Redact, then audit the allowed call.
  const redacted = deps.redact ? await deps.redact(result, { decision }) : result;
  await emit("allowed", decision, { credentialScope: credential?.scope });
  return { status: "ok", result: redacted };
}
