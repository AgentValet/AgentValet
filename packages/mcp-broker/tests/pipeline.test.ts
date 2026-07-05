// Pipeline-level tests: the outcomes that are awkward to reach through a full
// MCP round trip (unreachable policy source, failMode open, handler error) and
// the audit-event schema conformance for every terminating outcome.
import { describe, it, expect } from "vitest";
import { runPipeline, type PipelineDeps } from "../src/pipeline.js";
import { defaultIdentityResolver } from "../src/identity.js";
import { MemoryAuditSink } from "../src/audit/jsonl-sink.js";
import type { AccessRequest, AuditEvent, Credential, Decision, PolicySource, SecretSource } from "../src/types.js";

const OUTCOMES = ["allowed", "denied", "approval_timeout", "approval_denied", "handler_error"];

function assertConformant(ev: AuditEvent, args: unknown): void {
  expect(ev.schemaVersion).toBe(1);
  expect(typeof ev.ts).toBe("string");
  expect(ev.subject).toBeTruthy();
  expect(ev.resource).toHaveProperty("server");
  expect(ev.resource).toHaveProperty("tool");
  expect(typeof ev.action).toBe("string");
  expect(ev.argsFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(ev.decision).toHaveProperty("effect");
  expect(ev.decision).toHaveProperty("policyId");
  expect(ev.decision).toHaveProperty("version");
  expect(typeof ev.latencyMs).toBe("number");
  expect(OUTCOMES).toContain(ev.outcome);
  // The event must never carry the raw arguments in any field.
  const serialized = JSON.stringify(ev);
  if (args && typeof args === "object") {
    for (const v of Object.values(args as Record<string, unknown>)) {
      if (typeof v === "string" && v.length > 3) expect(serialized).not.toContain(v);
    }
  }
}

const okSecret: SecretSource = { async resolve() { return { token: "t", scope: ["s"] } as Credential; } };
const allowDecision: Decision = { effect: "allow", policyId: "p", version: "1", obligations: [{ type: "credential", ref: "c" }] };

function deps(over: Partial<PipelineDeps>): PipelineDeps {
  const base: PipelineDeps = {
    serverName: "srv",
    policy: { async evaluate() { return allowDecision; } },
    secrets: okSecret,
    audit: new MemoryAuditSink(),
    identity: defaultIdentityResolver,
    failMode: "closed",
    warn: () => {},
    ...over,
  };
  return base;
}

const params = { toolName: "do_thing", args: { secretArg: "topsecret-value" }, extra: { sessionId: "sess-1" } };

describe("pipeline failMode", () => {
  it("denies when the policy source is unreachable (failMode closed)", async () => {
    const audit = new MemoryAuditSink();
    const d = deps({ audit, policy: { async evaluate() { throw new Error("network down"); } } });
    const out = await runPipeline(d, params, async () => ({ ran: true }));
    expect(out).toEqual({ status: "blocked", effect: "deny", reason: "policy source unreachable" });
    const ev = audit.events.at(-1)!;
    expect(ev.outcome).toBe("denied");
    expect(ev.warnings?.some((w) => w.startsWith("policy_source_unreachable"))).toBe(true);
    assertConformant(ev, params.args);
  });

  it("allows-with-loud-warning when the policy source is unreachable and failMode is open", async () => {
    const audit = new MemoryAuditSink();
    const warnings: string[] = [];
    const d = deps({
      audit,
      failMode: "open",
      warn: (m) => warnings.push(m),
      policy: { async evaluate() { throw new Error("network down"); } },
    });
    let invoked = false;
    const out = await runPipeline(d, params, async () => { invoked = true; return { ran: true }; });
    expect(out.status).toBe("ok");
    expect(invoked).toBe(true);
    expect(warnings.join(" ")).toMatch(/failMode=open/);
    expect(audit.events.at(-1)!.warnings?.some((w) => w.startsWith("failMode_open"))).toBe(true);
  });
});

describe("pipeline audit conformance", () => {
  it("emits a conformant allowed event", async () => {
    const audit = new MemoryAuditSink();
    await runPipeline(deps({ audit }), params, async () => ({ ok: true }));
    const ev = audit.events.at(-1)!;
    expect(ev.outcome).toBe("allowed");
    assertConformant(ev, params.args);
  });

  it("emits a conformant denied event", async () => {
    const audit = new MemoryAuditSink();
    const d = deps({ audit, policy: { async evaluate() { return { effect: "deny", policyId: "p", version: "1" }; } } });
    await runPipeline(d, params, async () => ({ ok: true }));
    const ev = audit.events.at(-1)!;
    expect(ev.outcome).toBe("denied");
    assertConformant(ev, params.args);
  });

  it("emits a conformant approval_timeout event", async () => {
    const audit = new MemoryAuditSink();
    const d = deps({
      audit,
      policy: { async evaluate() { return { effect: "require_approval", policyId: "p", version: "1" }; } },
      approval: { async request() { return { approved: false, reason: "timeout" }; } },
    });
    await runPipeline(d, params, async () => ({ ok: true }));
    const ev = audit.events.at(-1)!;
    expect(ev.outcome).toBe("approval_timeout");
    assertConformant(ev, params.args);
  });

  it("emits a conformant handler_error event and rethrows", async () => {
    const audit = new MemoryAuditSink();
    const d = deps({ audit });
    await expect(
      runPipeline(d, params, async () => { throw new Error("boom in handler"); }),
    ).rejects.toThrow("boom in handler");
    const ev = audit.events.at(-1)!;
    expect(ev.outcome).toBe("handler_error");
    expect(ev.error).toBe("boom in handler");
    assertConformant(ev, params.args);
  });

  it("denies when the secret cannot be resolved", async () => {
    const audit = new MemoryAuditSink();
    const d = deps({ audit, secrets: { async resolve() { throw new Error("no secret"); } } });
    const out = await runPipeline(d, params, async () => ({ ok: true }));
    expect(out).toEqual({ status: "blocked", effect: "deny", reason: "credential could not be resolved" });
    expect(audit.events.at(-1)!.outcome).toBe("denied");
  });
});
