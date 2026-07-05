// packages/mcp-broker/src/_evaluator.ts
//
// GENERATED FILE — DO NOT EDIT BY HAND.
// Verbatim synced copy of packages/policy-kernel/src/evaluator.ts, produced
// by scripts/sync-policy-kernel.mjs. The public open-core mirror ships this
// package WITHOUT packages/policy-kernel, so the broker carries a synced copy
// rather than a workspace import. The contract suite
// (supabase/functions/policies/__tests__/evaluator-contract.test.ts) fails if
// this copy drifts from the kernel source. To change evaluation semantics:
// edit the kernel, run
//   node scripts/sync-policy-kernel.mjs
// and commit all copies together.
// BEGIN SYNCED SOURCE (everything below this line is the kernel file)
// packages/policy-kernel/src/evaluator.ts
//
// THE policy evaluator. Pure function, no I/O, deterministic. This file is
// the single source of truth for allow/deny/approval semantics:
//   - apps/proxy enforces with it (via @agentvalet/policy-kernel),
//   - supabase/functions/policies previews with a verbatim synced copy
//     (_evaluator.ts — Deno can't import the Node workspace; the sync is
//     enforced byte-for-byte by the evaluator contract test suite).
// Change semantics ONLY here, then run scripts/sync-policy-kernel.mjs.
//
// Semantics (see docs/User_Policy/2026-05-29-user-policies-design.md §5):
//   1. Guardrails first. Any deny matching → deny outright.
//   2. Otherwise, collect guardrail require_approval matches.
//   3. Policy: no allow match → deny. Any deny match → deny.
//   4. Otherwise, collect policy approval-rule matches.
//   5. If any require_approval flag set (from guardrails or policy) → approval_required.
//   6. Otherwise → allow.
//
// Every evaluation also produces a DecisionTrace — the ordered list of events
// that led to the verdict (which guardrail/rule matched, what was skipped and
// why). evaluatePolicy() discards it; evaluatePolicyWithTrace() returns it.
// The trace references rule targets, tags, and ids only — never credentials
// or payloads — so it is safe to persist alongside audit entries.

export type TargetType = "platform" | "tag" | "scope";
export type Effect = "allow" | "deny";
export type Role = "admin" | "member";

export interface PolicyRule {
  effect: Effect;
  targetType: TargetType;
  targetValue: string;
}

export interface ApprovalRule {
  targetType: TargetType;
  targetValue: string;
}

export interface PolicySnapshot {
  id: string;
  version: number;
  rules: PolicyRule[];
  approvalRules: ApprovalRule[];
}

export interface Guardrail {
  id: string;
  enforcement: "deny" | "require_approval";
  targetType: TargetType;
  targetValue: string;
  appliesToRole: Role | null;
}

export interface EvaluationInput {
  policy: PolicySnapshot | null;
  guardrails: Guardrail[];
  callerRole: Role;
  requestedScopeTags: string[];
  requested: { platformId: string; scopeId: string };
}

export type EvaluationResult =
  | { decision: "allow"; policyId: string; policyVersion: number }
  | { decision: "approval_required"; reason: "approval_required_by_guardrail"; guardrailId: string }
  | { decision: "approval_required"; reason: "approval_required_by_policy"; policyId: string; policyVersion: number }
  | { decision: "deny"; reason: "no_policy_assigned" }
  | { decision: "deny"; reason: "denied_by_guardrail"; guardrailId: string }
  | { decision: "deny"; reason: "denied_by_policy"; policyId: string; policyVersion: number };

// ---------------------------------------------------------------------------
// Decision trace
// ---------------------------------------------------------------------------

export const TRACE_VERSION = 1;

export interface TraceTargetRef {
  targetType: TargetType;
  targetValue: string;
}

export type DecisionTraceEvent =
  | { kind: "guardrail_skipped_role"; guardrailId: string; appliesToRole: Role }
  | { kind: "guardrail_deny_matched"; guardrailId: string; target: TraceTargetRef }
  | { kind: "guardrail_approval_matched"; guardrailId: string; target: TraceTargetRef }
  | { kind: "no_policy_assigned" }
  | { kind: "policy_allow_matched"; policyId: string; rule: TraceTargetRef }
  | { kind: "policy_no_allow_matched"; policyId: string; allowRulesConsidered: number }
  | { kind: "policy_deny_matched"; policyId: string; rule: TraceTargetRef }
  | { kind: "policy_approval_matched"; policyId: string; rule: TraceTargetRef };

export interface DecisionTrace {
  version: typeof TRACE_VERSION;
  input: {
    platformId: string;
    scopeId: string;
    callerRole: Role;
    requestedScopeTags: string[];
  };
  events: DecisionTraceEvent[];
}

export interface TracedEvaluation {
  result: EvaluationResult;
  trace: DecisionTrace;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function targetMatches(
  targetType: TargetType,
  targetValue: string,
  req: EvaluationInput["requested"],
  tags: string[],
): boolean {
  switch (targetType) {
    case "platform":
      return targetValue === req.platformId;
    case "tag":
      return tags.includes(targetValue);
    case "scope":
      return targetValue === `${req.platformId}:${req.scopeId}`;
  }
}

export function evaluatePolicyWithTrace(input: EvaluationInput): TracedEvaluation {
  const { policy, guardrails, callerRole, requestedScopeTags, requested } = input;

  const events: DecisionTraceEvent[] = [];
  const done = (result: EvaluationResult): TracedEvaluation => ({
    result,
    trace: {
      version: TRACE_VERSION,
      input: {
        platformId: requested.platformId,
        scopeId: requested.scopeId,
        callerRole,
        requestedScopeTags: [...requestedScopeTags],
      },
      events,
    },
  });

  // 1. Guardrails — deny pass first.
  for (const g of guardrails) {
    if (g.appliesToRole && g.appliesToRole !== callerRole) {
      events.push({ kind: "guardrail_skipped_role", guardrailId: g.id, appliesToRole: g.appliesToRole });
      continue;
    }
    if (!targetMatches(g.targetType, g.targetValue, requested, requestedScopeTags)) continue;
    if (g.enforcement === "deny") {
      events.push({
        kind: "guardrail_deny_matched",
        guardrailId: g.id,
        target: { targetType: g.targetType, targetValue: g.targetValue },
      });
      return done({ decision: "deny", reason: "denied_by_guardrail", guardrailId: g.id });
    }
  }

  // 2. Guardrails — require_approval pass. (Role skips were already traced in
  //    pass 1; don't duplicate them here.)
  let guardrailApprovalId: string | null = null;
  for (const g of guardrails) {
    if (g.appliesToRole && g.appliesToRole !== callerRole) continue;
    if (!targetMatches(g.targetType, g.targetValue, requested, requestedScopeTags)) continue;
    if (g.enforcement === "require_approval") {
      guardrailApprovalId = g.id;
      events.push({
        kind: "guardrail_approval_matched",
        guardrailId: g.id,
        target: { targetType: g.targetType, targetValue: g.targetValue },
      });
      break;
    }
  }

  // 3. Policy must exist.
  if (!policy) {
    events.push({ kind: "no_policy_assigned" });
    return done({ decision: "deny", reason: "no_policy_assigned" });
  }

  // 4. Policy rules: at least one allow, no deny.
  let hasAllow = false;
  let allowRulesConsidered = 0;
  for (const r of policy.rules) {
    if (r.effect !== "allow") continue;
    allowRulesConsidered++;
    if (targetMatches(r.targetType, r.targetValue, requested, requestedScopeTags)) {
      hasAllow = true;
      events.push({
        kind: "policy_allow_matched",
        policyId: policy.id,
        rule: { targetType: r.targetType, targetValue: r.targetValue },
      });
      break;
    }
  }
  if (!hasAllow) {
    events.push({ kind: "policy_no_allow_matched", policyId: policy.id, allowRulesConsidered });
    return done({ decision: "deny", reason: "denied_by_policy", policyId: policy.id, policyVersion: policy.version });
  }
  for (const r of policy.rules) {
    if (r.effect !== "deny") continue;
    if (targetMatches(r.targetType, r.targetValue, requested, requestedScopeTags)) {
      events.push({
        kind: "policy_deny_matched",
        policyId: policy.id,
        rule: { targetType: r.targetType, targetValue: r.targetValue },
      });
      return done({ decision: "deny", reason: "denied_by_policy", policyId: policy.id, policyVersion: policy.version });
    }
  }

  // 5. Approval rules (policy-side).
  let policyApproval = false;
  for (const ar of policy.approvalRules) {
    if (targetMatches(ar.targetType, ar.targetValue, requested, requestedScopeTags)) {
      policyApproval = true;
      events.push({
        kind: "policy_approval_matched",
        policyId: policy.id,
        rule: { targetType: ar.targetType, targetValue: ar.targetValue },
      });
      break;
    }
  }

  // 6. Combine approval signals. Guardrail approval takes precedence in the reason
  //    code because it's the org-wide rule, but functionally either is approval_required.
  if (guardrailApprovalId) {
    return done({
      decision: "approval_required",
      reason: "approval_required_by_guardrail",
      guardrailId: guardrailApprovalId,
    });
  }
  if (policyApproval) {
    return done({
      decision: "approval_required",
      reason: "approval_required_by_policy",
      policyId: policy.id,
      policyVersion: policy.version,
    });
  }

  return done({ decision: "allow", policyId: policy.id, policyVersion: policy.version });
}

export function evaluatePolicy(input: EvaluationInput): EvaluationResult {
  return evaluatePolicyWithTrace(input).result;
}
