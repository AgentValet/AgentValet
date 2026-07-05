// The agentvalet: policy source. Evaluates each tool call against the hosted
// control plane by calling the live AuthZEN access endpoint the platform
// already runs (POST /v1/authzen/access). This reuses the hosted decision path
// rather than forking it: the request is translated into the AuthZEN shape the
// endpoint expects, and the boolean verdict is translated back into a broker
// Decision.
//
// Divergence to know (live code wins): /v1/authzen/access is a boolean
// allow/deny gate keyed on granted scopes. It does not emit require_approval;
// approval lives in the /v1/actions pipeline. So a hosted decision here is
// allow or deny only. When the broker-side approval surface lands (see the seam
// note), this source elevates to require_approval from the same response.
import { HostedClient, type HostedOptions } from "./client.js";
import type { AccessRequest, Decision, PolicySource } from "../types.js";

interface AuthZenAccessResult {
  decision?: boolean;
  reason?: string;
}

export class AgentvaletPolicySource implements PolicySource {
  private readonly client: HostedClient;
  private readonly agentId?: string;

  constructor(opts: HostedOptions) {
    this.client = new HostedClient(opts);
    this.agentId = opts.agentId;
  }

  async evaluate(req: AccessRequest): Promise<Decision> {
    const subjectId = await this.client.subjectId(this.agentId);
    // resource.id is "<platform>:<scope>"; the MCP server is the platform and
    // the tool is the scope, matching the endpoint's colon-split contract.
    const resourceId = `${req.resource.server}:${req.resource.tool}`;
    const body = {
      subject: { type: "agent", id: subjectId },
      action: { name: req.action.name },
      resource: { type: "tool", id: resourceId },
      context: {
        timestamp: req.context.ts,
        // Non-authoritative hints; the endpoint derives ownership from the JWT.
        session_id: req.subject.sessionId,
        args_fingerprint: req.context.argsFingerprint,
      },
    };

    const result = (await this.client.request("POST", "/v1/authzen/access", body)) as AuthZenAccessResult;
    if (result.decision === true) {
      return {
        effect: "allow",
        policyId: "agentvalet",
        version: "1",
        obligations: [{ type: "credential", ref: resourceId }],
      };
    }
    return { effect: "deny", policyId: "agentvalet", version: "1", obligations: [] };
  }
}
