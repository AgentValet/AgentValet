// The authzen: policy source. Because AccessRequest is already AuthZEN-shaped,
// this is a thin adapter: map the request to a conformant AuthZEN Authorization
// API evaluation call, POST it to an external Policy Decision Point, and map the
// boolean decision (plus any obligations) back to a broker Decision. This is
// what makes "bring your own PDP" a one-pager rather than a fork.
//
// Reference: OpenID AuthZEN Authorization API 1.0, POST <pdp>/access/v1/evaluation
//   request : { subject, action, resource, context }
//   response: { decision: boolean, context?: { id?, reason_admin?, obligations? } }
import type { AccessRequest, Decision, Obligation, PolicySource } from "../types.js";

type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface AuthzenOptions {
  fetch?: FetchLike;
  headers?: Record<string, string>;
}

// AuthZEN obligations are a list of typed directives. The broker understands two
// and ignores the rest. An "approval" obligation elevates an allow to
// require_approval so an external PDP can drive the broker's approval flow.
function mapObligations(raw: unknown): { obligations: Obligation[]; requiresApproval: boolean } {
  const obligations: Obligation[] = [];
  let requiresApproval = false;
  if (!Array.isArray(raw)) return { obligations, requiresApproval };
  for (const o of raw) {
    if (o == null || typeof o !== "object") continue;
    const id = (o as Record<string, unknown>).id;
    const attrs = ((o as Record<string, unknown>).attributes ?? {}) as Record<string, unknown>;
    if (id === "approval" || id === "require_approval") {
      requiresApproval = true;
      continue;
    }
    if (id === "credential" && typeof attrs.ref === "string") {
      const scope = Array.isArray(attrs.scope) ? (attrs.scope as unknown[]).filter((s): s is string => typeof s === "string") : undefined;
      obligations.push(scope ? { type: "credential", ref: attrs.ref, scope } : { type: "credential", ref: attrs.ref });
    } else if (id === "narrow_scope" && Array.isArray(attrs.scope)) {
      obligations.push({ type: "narrow_scope", scope: (attrs.scope as unknown[]).filter((s): s is string => typeof s === "string") });
    }
  }
  return { obligations, requiresApproval };
}

export function toAuthzenRequest(req: AccessRequest): Record<string, unknown> {
  const subjectProps: Record<string, unknown> = { sessionId: req.subject.sessionId };
  if (req.subject.spiffeId) subjectProps.spiffeId = req.subject.spiffeId;
  return {
    subject: { type: "agent", id: req.subject.id, properties: subjectProps },
    action: { name: req.action.name },
    resource: { type: "tool", id: req.resource.tool, properties: { server: req.resource.server } },
    context: {
      argsFingerprint: req.context.argsFingerprint,
      transport: req.context.transport,
      ts: req.context.ts,
    },
  };
}

export class AuthzenPolicySource implements PolicySource {
  private readonly url: string;
  private readonly fetch: FetchLike;
  private readonly headers: Record<string, string>;

  constructor(pdpBaseUrl: string, opts: AuthzenOptions = {}) {
    const base = pdpBaseUrl.replace(/\/+$/, "");
    this.url = base.endsWith("/evaluation") ? base : `${base}/access/v1/evaluation`;
    const f = opts.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!f) throw new Error("authzen: policy source requires a fetch implementation (Node >=18 or an injected fetch)");
    this.fetch = f;
    this.headers = { "content-type": "application/json", accept: "application/json", ...(opts.headers ?? {}) };
  }

  async evaluate(req: AccessRequest): Promise<Decision> {
    const res = await this.fetch(this.url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(toAuthzenRequest(req)),
    });
    if (!res.ok) {
      // A PDP that answers with an error is treated as unreachable: throw and
      // let the pipeline's failMode decide (deny, by default).
      throw new Error(`authzen PDP returned HTTP ${res.status}`);
    }
    const body = (await res.json()) as { decision?: unknown; context?: { obligations?: unknown } };
    const decision = body?.decision === true;
    const { obligations, requiresApproval } = mapObligations(body?.context?.obligations);

    if (!decision) return { effect: "deny", policyId: "authzen", version: "1", obligations: [] };
    return {
      effect: requiresApproval ? "require_approval" : "allow",
      policyId: "authzen",
      version: "1",
      obligations,
    };
  }
}
