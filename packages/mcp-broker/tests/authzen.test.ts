import { describe, it, expect } from "vitest";
import { AuthzenPolicySource, toAuthzenRequest } from "../src/policy/authzen-source.js";
import type { AccessRequest } from "../src/types.js";

const req: AccessRequest = {
  subject: { id: "client-123", sessionId: "sess-9", spiffeId: "spiffe://ex/agent" },
  action: { name: "create_issue" },
  resource: { server: "github-tools", tool: "create_issue" },
  context: { argsFingerprint: "sha256:aa", transport: "http", ts: "2026-07-04T00:00:00.000Z" },
};

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fn = async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fn, calls };
}

describe("authzen adapter", () => {
  it("maps an AccessRequest to a conformant AuthZEN evaluation request", () => {
    const r = toAuthzenRequest(req) as {
      subject: { type: string; id: string; properties: Record<string, unknown> };
      action: { name: string };
      resource: { type: string; id: string; properties: Record<string, unknown> };
      context: Record<string, unknown>;
    };
    expect(r.subject).toEqual({
      type: "agent",
      id: "client-123",
      properties: { sessionId: "sess-9", spiffeId: "spiffe://ex/agent" },
    });
    expect(r.action).toEqual({ name: "create_issue" });
    expect(r.resource).toEqual({ type: "tool", id: "create_issue", properties: { server: "github-tools" } });
    expect(r.context.argsFingerprint).toBe("sha256:aa");
  });

  it("POSTs to the AuthZEN evaluation endpoint and maps decision:true to allow", async () => {
    const { fn, calls } = fakeFetch(200, { decision: true });
    const src = new AuthzenPolicySource("https://pdp.example.com", { fetch: fn });
    const d = await src.evaluate(req);
    expect(calls[0].url).toBe("https://pdp.example.com/access/v1/evaluation");
    expect(d.effect).toBe("allow");
    expect(d.policyId).toBe("authzen");
  });

  it("maps decision:false to deny", async () => {
    const { fn } = fakeFetch(200, { decision: false });
    const d = await new AuthzenPolicySource("https://pdp.example.com", { fetch: fn }).evaluate(req);
    expect(d.effect).toBe("deny");
  });

  it("maps an approval obligation to require_approval and carries credential/scope obligations back", async () => {
    const { fn } = fakeFetch(200, {
      decision: true,
      context: {
        obligations: [
          { id: "approval" },
          { id: "credential", attributes: { ref: "github_admin", scope: ["repo:delete"] } },
          { id: "narrow_scope", attributes: { scope: ["repo:delete"] } },
        ],
      },
    });
    const d = await new AuthzenPolicySource("https://pdp.example.com", { fetch: fn }).evaluate(req);
    expect(d.effect).toBe("require_approval");
    expect(d.obligations).toContainEqual({ type: "credential", ref: "github_admin", scope: ["repo:delete"] });
    expect(d.obligations).toContainEqual({ type: "narrow_scope", scope: ["repo:delete"] });
  });

  it("treats an HTTP error from the PDP as unreachable (throws, so the pipeline denies)", async () => {
    const { fn } = fakeFetch(503, {});
    await expect(new AuthzenPolicySource("https://pdp.example.com", { fetch: fn }).evaluate(req)).rejects.toThrow(/503/);
  });

  it("does not double-append the evaluation path when the base already ends in /evaluation", async () => {
    const { fn, calls } = fakeFetch(200, { decision: true });
    await new AuthzenPolicySource("https://pdp.example.com/access/v1/evaluation", { fetch: fn }).evaluate(req);
    expect(calls[0].url).toBe("https://pdp.example.com/access/v1/evaluation");
  });
});
