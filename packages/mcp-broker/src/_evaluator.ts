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
//
// Predicates (CodePrompts/Affindi-Competitor/06-policy-as-code-escape-hatch-
// design.md). A policy rule or approval rule may carry an optional predicate
// ({lang: "cel", text}). It is a MATCH GUARD: the rule matches iff its target
// matches AND the predicate evaluates true. It changes nothing about the
// precedence above, so a predicate can narrow an allow or widen a deny or an
// approval, never grant. The language engine is INJECTED through
// EvaluationInput.predicate (this file must stay import-free: it is synced
// byte-for-byte into the Deno edge function and the open-core broker), and
// every non-true outcome fails closed:
//   allow rule:    false / error / unavailable => the rule does not match
//   deny rule:     false => falls through; error / unavailable => matches (deny)
//   approval rule: false => falls through; error / unavailable => matches (ask)
// In discovery mode (mode omitted or "discovery": list_platforms, preview)
// the engine is not consulted at all: a predicated allow counts as allowed
// but conditional, a predicated deny as not matching, a predicated approval
// as asking, and the trace carries `conditional: true` so discovery can
// advertise the scope as conditional and fold that into its version hash.

export type TargetType = "platform" | "tag" | "scope";
export type Effect = "allow" | "deny";
export type Role = "admin" | "member";

export type PredicateLang = "cel";

export interface RulePredicate {
  lang: PredicateLang;
  text: string;
}

export interface PolicyRule {
  // Row id when loaded from the database; absent on drafts. Only echoed in
  // trace events so an auditor can name the rule that decided a call.
  id?: string;
  effect: Effect;
  targetType: TargetType;
  targetValue: string;
  predicate?: RulePredicate | null;
}

export interface ApprovalRule {
  id?: string;
  targetType: TargetType;
  targetValue: string;
  predicate?: RulePredicate | null;
}

export type PredicateOutcome = "true" | "false" | "error";

/**
 * The injected language engine. Pure: same predicate + same request => same
 * outcome. It must never throw; if it does, the kernel records `error`.
 * The request context the predicate reads is closed over by the caller
 * (the proxy builds it once per call), so the kernel never sees it.
 */
export interface PredicateEvaluator {
  evaluate(predicate: RulePredicate): PredicateOutcome;
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
  // "call": a real request is being decided; predicates are evaluated through
  // `predicate`, and a missing engine (org not entitled, engine not wired)
  // fails closed. "discovery" (the default): no request context exists, so
  // predicates are not evaluated and the discovery defaults above apply.
  mode?: "call" | "discovery";
  predicate?: PredicateEvaluator;
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

export const TRACE_VERSION = 2;

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
  | { kind: "policy_approval_matched"; policyId: string; rule: TraceTargetRef }
  // A predicate ran (call mode). `unavailable` = no engine injected, which
  // is how an un-entitled org's predicated rules show up: fail-closed, visibly.
  | {
      kind: "rule_predicate_evaluated";
      ruleId: string | null;
      scope: "policy_rule" | "approval_rule";
      lang: PredicateLang;
      outcome: PredicateOutcome | "unavailable";
    }
  // Discovery mode: the predicate was not evaluated and the discovery
  // default was applied instead.
  | { kind: "rule_predicate_deferred"; ruleId: string | null; scope: "policy_rule" | "approval_rule"; lang: PredicateLang };

export interface DecisionTrace {
  version: typeof TRACE_VERSION;
  input: {
    platformId: string;
    scopeId: string;
    callerRole: Role;
    requestedScopeTags: string[];
  };
  events: DecisionTraceEvent[];
  // Present (true) only in discovery mode when at least one predicated rule
  // shaped the verdict: the answer is "allowed, but conditional at call time".
  conditional?: true;
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
  const mode = input.mode ?? "discovery";

  const events: DecisionTraceEvent[] = [];
  let conditional = false;
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
      ...(conditional ? { conditional: true as const } : {}),
    },
  });

  // Does this rule's predicate let it match? `onUnknown` is the fail-closed
  // answer for error/unavailable: false for an allow (no grant), true for a
  // deny or an approval (deny / ask). `onDiscovery` is the discovery default.
  function predicatePasses(
    rule: { id?: string; predicate?: RulePredicate | null },
    scope: "policy_rule" | "approval_rule",
    onUnknown: boolean,
    onDiscovery: boolean,
  ): boolean {
    const pred = rule.predicate;
    if (!pred) return true;
    const ruleId = rule.id ?? null;
    if (mode !== "call") {
      events.push({ kind: "rule_predicate_deferred", ruleId, scope, lang: pred.lang });
      conditional = true;
      return onDiscovery;
    }
    if (!input.predicate) {
      events.push({ kind: "rule_predicate_evaluated", ruleId, scope, lang: pred.lang, outcome: "unavailable" });
      return onUnknown;
    }
    let outcome: PredicateOutcome;
    try {
      const o = input.predicate.evaluate(pred);
      outcome = o === "true" || o === "false" ? o : "error";
    } catch {
      outcome = "error";
    }
    events.push({ kind: "rule_predicate_evaluated", ruleId, scope, lang: pred.lang, outcome });
    if (outcome === "true") return true;
    if (outcome === "false") return false;
    return onUnknown;
  }

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
    // Predicated allow: unknown => no match (no grant); discovery => match, conditional.
    if (targetMatches(r.targetType, r.targetValue, requested, requestedScopeTags) && predicatePasses(r, "policy_rule", false, true)) {
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
    // Predicated deny: unknown => match (deny); discovery => no match (scope stays advertised).
    if (targetMatches(r.targetType, r.targetValue, requested, requestedScopeTags) && predicatePasses(r, "policy_rule", true, false)) {
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
    // Predicated approval: unknown => match (ask); discovery => match (advertise the stricter case).
    if (targetMatches(ar.targetType, ar.targetValue, requested, requestedScopeTags) && predicatePasses(ar, "approval_rule", true, true)) {
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
