// The agentvalet: audit sink. Ships each broker AuditEvent to the hosted
// append-only log so a fleet has one central, tamper-evident record instead of
// a JSONL file per server. The event shape is already the stable versioned
// schema; the sink just posts it. Emit failures are surfaced by the pipeline
// (best-effort at the boundary) and never change an authorization outcome.
import { HostedClient, type HostedOptions } from "./client.js";
import { BROKER_AUDIT } from "./endpoints.js";
import type { AuditEvent, AuditSink } from "../types.js";

export class AgentvaletAuditSink implements AuditSink {
  private readonly client: HostedClient;

  constructor(opts: HostedOptions) {
    this.client = new HostedClient(opts);
  }

  async emit(event: AuditEvent): Promise<void> {
    await this.client.request("POST", BROKER_AUDIT, event);
  }
}
