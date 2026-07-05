// The agentvalet: approval provider. Opens an approval request on the hosted
// plane (which drives the existing push-approval flow to the owner's devices)
// and then polls the status endpoint until the owner decides or the request
// times out. Deny-on-timeout matches the local CLI provider.
//
// It polls rather than holding a stream open. The hosted approval channel is an
// SSE flow with a known reconnect limitation (already public in the roadmap);
// this provider does not paper over it. Polling the status endpoint is the
// resilient reading of that same flow, and the poll budget is configurable.
import { HostedClient, type HostedOptions } from "./client.js";
import { BROKER_APPROVALS, APPROVAL_STATUS } from "./endpoints.js";
import type { AccessRequest, ApprovalProvider, ApprovalResult, Decision } from "../types.js";

export interface HostedApprovalOptions extends HostedOptions {
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface ApprovalCreated {
  id?: string;
}
interface ApprovalStatus {
  status?: "pending" | "approved" | "denied" | "expired" | string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class AgentvaletApprovalProvider implements ApprovalProvider {
  private readonly client: HostedClient;
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(opts: HostedApprovalOptions) {
    this.client = new HostedClient(opts);
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.pollMs = opts.pollMs ?? 2_000;
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? (() => Date.now());
  }

  async request(req: AccessRequest, decision: Decision): Promise<ApprovalResult> {
    const created = (await this.client.request("POST", BROKER_APPROVALS, {
      server: req.resource.server,
      tool: req.resource.tool,
      subject: req.subject,
      argsFingerprint: req.context.argsFingerprint,
      policyId: decision.policyId,
      policyVersion: decision.version,
    })) as ApprovalCreated;

    if (!created?.id) throw new Error("hosted approval create returned no id");
    const statusPath = APPROVAL_STATUS(created.id);
    const deadline = this.now() + this.timeoutMs;

    while (this.now() < deadline) {
      const status = (await this.client.request("GET", statusPath)) as ApprovalStatus;
      if (status.status === "approved") return { approved: true };
      if (status.status === "denied") return { approved: false, reason: "declined" };
      if (status.status === "expired") return { approved: false, reason: "timeout" };
      await this.sleep(this.pollMs);
    }
    return { approved: false, reason: "timeout" };
  }
}
