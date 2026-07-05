// Shared scope-narrowing rule for the local secret sources. The contract (A4)
// is that a SecretSource MUST honour scope narrowing carried on the decision's
// obligations. Precedence: an explicit narrow_scope obligation wins, then a
// scope attached to the credential obligation, then the ref's own scope.
import type { CredentialRef, Decision, Obligation } from "../types.js";

function ofType<T extends Obligation["type"]>(
  decision: Decision,
  type: T,
): Extract<Obligation, { type: T }> | undefined {
  return (decision.obligations ?? []).find((o) => o.type === type) as
    | Extract<Obligation, { type: T }>
    | undefined;
}

export function narrowedScope(ref: CredentialRef, decision: Decision): string[] | undefined {
  const narrow = ofType(decision, "narrow_scope");
  if (narrow && Array.isArray(narrow.scope)) return narrow.scope;
  const cred = ofType(decision, "credential");
  if (cred && Array.isArray(cred.scope)) return cred.scope;
  return ref.scope;
}
