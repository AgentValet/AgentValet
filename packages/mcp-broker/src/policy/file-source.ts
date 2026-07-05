// The file: policy source. Reads the local YAML, and evaluates each request
// through the SAME kernel the hosted plane runs (src/_evaluator.ts is a
// byte-identical synced copy of packages/policy-kernel/src/evaluator.ts). That
// is the flagship trust claim: a rule you write locally decides allow / deny /
// require_approval with identical semantics to the cloud, provably.
//
// The local YAML is tool-centric (A5). The kernel is platform/tag/scope-centric.
// The translation maps the MCP server to the kernel's "platform" and each tool
// to a "scope" target keyed as `<server>:<tool>`. No tags and no guardrails
// exist locally; those are hosted concepts, so the kernel runs with an empty
// guardrail set and the single-developer "member" role.
import { readFile } from "node:fs/promises";
import { evaluatePolicy } from "../_evaluator.js";
import type {
  EvaluationInput,
  PolicyRule as KernelRule,
  ApprovalRule as KernelApprovalRule,
} from "../_evaluator.js";
import { parsePolicy, type PolicyDoc } from "./yaml.js";
import type { AccessRequest, Decision, Obligation, PolicySource } from "../types.js";

function target(server: string, tool: string): string {
  return `${server}:${tool}`;
}

// Build the kernel input for one request from the parsed local document.
function toEvaluationInput(doc: PolicyDoc, req: AccessRequest): EvaluationInput {
  const server = req.resource.server;
  const rules: KernelRule[] = [];
  const approvalRules: KernelApprovalRule[] = [];

  for (const r of doc.rules) {
    const tv = target(server, r.tool);
    if (r.effect === "deny") {
      rules.push({ effect: "deny", targetType: "scope", targetValue: tv });
    } else {
      // allow AND require_approval both need an allow match to clear the
      // kernel's "no allow -> deny" gate; require_approval additionally carries
      // an approval rule so the verdict lands on approval_required.
      rules.push({ effect: "allow", targetType: "scope", targetValue: tv });
      if (r.effect === "require_approval") {
        approvalRules.push({ targetType: "scope", targetValue: tv });
      }
    }
  }

  // defaults.effect: allow adds a catch-all so unlisted tools clear the gate.
  if (doc.defaults.effect === "allow") {
    rules.push({ effect: "allow", targetType: "platform", targetValue: server });
  }

  return {
    policy: { id: "local", version: doc.version, rules, approvalRules },
    guardrails: [],
    callerRole: "member",
    requestedScopeTags: [],
    requested: { platformId: server, scopeId: req.resource.tool },
  };
}

function obligationsFor(doc: PolicyDoc, tool: string): Obligation[] {
  const rule = doc.rules.find((r) => r.tool === tool);
  if (rule?.credential) return [{ type: "credential", ref: rule.credential }];
  return [];
}

export class FilePolicySource implements PolicySource {
  private doc: PolicyDoc | null = null;

  constructor(private readonly path: string) {}

  // Loaded lazily and cached. A read or parse failure throws, so the pipeline's
  // failMode (closed by default) turns an unreachable/broken policy into a deny.
  private async load(): Promise<PolicyDoc> {
    if (this.doc) return this.doc;
    const raw = await readFile(this.path, "utf8");
    this.doc = parsePolicy(raw);
    return this.doc;
  }

  async evaluate(req: AccessRequest): Promise<Decision> {
    const doc = await this.load();
    const result = evaluatePolicy(toEvaluationInput(doc, req));
    const version = String(doc.version);

    if (result.decision === "allow") {
      return { effect: "allow", policyId: "local", version, obligations: obligationsFor(doc, req.resource.tool) };
    }
    if (result.decision === "approval_required") {
      return {
        effect: "require_approval",
        policyId: "local",
        version,
        obligations: obligationsFor(doc, req.resource.tool),
      };
    }
    return { effect: "deny", policyId: "local", version, obligations: [] };
  }
}
