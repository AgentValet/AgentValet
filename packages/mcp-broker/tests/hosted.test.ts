// The hosted (agentvalet:) sources, exercised with an injected fetch so the
// translate-in / translate-out mapping is pinned without a network. The policy
// source targets the real /v1/authzen/access contract; the secret, audit, and
// approval sources target the documented broker surface.
import { describe, it, expect } from "vitest";
import { HostedClient, HostedHttpError, agentIdFromToken, resolveApiUrl, type FetchLike } from "../src/hosted/client.js";
import { AgentvaletPolicySource } from "../src/hosted/policy-source.js";
import { AgentvaletSecretSource } from "../src/hosted/secret-source.js";
import { AgentvaletAuditSink } from "../src/hosted/audit-sink.js";
import { AgentvaletApprovalProvider } from "../src/hosted/approval-provider.js";
import type { AccessRequest, AuditEvent, Decision } from "../src/types.js";

interface Call { url: string; method: string; headers: Record<string, string>; body?: unknown }

function recorder(handler: (call: Call) => { status?: number; body: unknown }): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: Call = { url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const { status = 200, body } = handler(call);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetch, calls };
}

const req: AccessRequest = {
  subject: { id: "sess-1", sessionId: "sess-1" },
  action: { name: "create_issue" },
  resource: { server: "github-tools", tool: "create_issue" },
  context: { argsFingerprint: "sha256:aa", transport: "http", ts: "2026-07-04T00:00:00.000Z" },
};
const allow: Decision = { effect: "allow", policyId: "agentvalet", version: "1" };

describe("hosted client", () => {
  it("throws without a token", () => {
    expect(() => new HostedClient({ fetch: recorder(() => ({ body: {} })).fetch })).toThrow(/token/);
  });

  it("sends a bearer header and honours AGENTVALET_API_URL default override", async () => {
    const { fetch, calls } = recorder(() => ({ body: { ok: true } }));
    const c = new HostedClient({ token: "tok-123", fetch, apiUrl: "https://api.example.test" });
    await c.request("POST", "/v1/x", { a: 1 });
    expect(calls[0].url).toBe("https://api.example.test/v1/x");
    expect(calls[0].headers.authorization).toBe("Bearer tok-123");
    expect(calls[0].body).toEqual({ a: 1 });
  });

  it("raises HostedHttpError on a non-2xx", async () => {
    const { fetch } = recorder(() => ({ status: 503, body: {} }));
    const c = new HostedClient({ token: "t", fetch });
    await expect(c.request("GET", "/v1/x")).rejects.toBeInstanceOf(HostedHttpError);
  });

  it("defaults the base url to the production host", () => {
    expect(resolveApiUrl()).toBe("https://api.agentvalet.ai");
  });

  it("derives an agent id from a JWT agent_id claim", () => {
    const payload = Buffer.from(JSON.stringify({ agent_id: "agt_abc" })).toString("base64url");
    expect(agentIdFromToken(`h.${payload}.sig`)).toBe("agt_abc");
    expect(agentIdFromToken("not-a-jwt")).toBeUndefined();
  });
});

describe("agentvalet policy source", () => {
  it("maps to the AuthZEN access contract and back (allow)", async () => {
    const { fetch, calls } = recorder((c) => {
      expect(c.url).toMatch(/\/v1\/authzen\/access$/);
      return { body: { decision: true, reason: "approved" } };
    });
    const src = new AgentvaletPolicySource({ token: "t", fetch, agentId: "agt_x" });
    const d = await src.evaluate(req);
    expect(calls[0].body).toMatchObject({
      subject: { type: "agent", id: "agt_x" },
      action: { name: "create_issue" },
      resource: { type: "tool", id: "github-tools:create_issue" },
    });
    expect(d.effect).toBe("allow");
    expect(d.obligations).toEqual([{ type: "credential", ref: "github-tools:create_issue" }]);
  });

  it("maps decision:false to deny", async () => {
    const { fetch } = recorder(() => ({ body: { decision: false, reason: "scope_not_granted" } }));
    const d = await new AgentvaletPolicySource({ token: "t", fetch, agentId: "agt_x" }).evaluate(req);
    expect(d.effect).toBe("deny");
  });
});

describe("agentvalet secret source", () => {
  it("posts the ref and obligations and maps the minted credential", async () => {
    const { fetch, calls } = recorder((c) => {
      expect(c.url).toMatch(/\/v1\/broker\/credential$/);
      return { body: { token: "mint-xyz", scope: ["issues:write"], expiresAt: "2026-07-04T00:05:00.000Z" } };
    });
    const decision: Decision = { ...allow, obligations: [{ type: "narrow_scope", scope: ["issues:write"] }] };
    const cred = await new AgentvaletSecretSource({ token: "t", fetch }).resolve({ id: "github-tools:create_issue" }, decision);
    expect(calls[0].body).toMatchObject({ ref: "github-tools:create_issue", obligations: [{ type: "narrow_scope", scope: ["issues:write"] }] });
    expect(cred.token).toBe("mint-xyz");
    expect(cred.scope).toEqual(["issues:write"]);
    expect(cred.expiresAt?.toISOString()).toBe("2026-07-04T00:05:00.000Z");
  });

  it("throws if the mint returns no token", async () => {
    const { fetch } = recorder(() => ({ body: {} }));
    await expect(new AgentvaletSecretSource({ token: "t", fetch }).resolve({ id: "x" }, allow)).rejects.toThrow(/no token/);
  });
});

describe("agentvalet audit sink", () => {
  it("posts the audit event to the broker audit endpoint", async () => {
    const { fetch, calls } = recorder(() => ({ body: { ok: true } }));
    const event = { schemaVersion: 1, action: "create_issue", outcome: "allowed" } as unknown as AuditEvent;
    await new AgentvaletAuditSink({ token: "t", fetch }).emit(event);
    expect(calls[0].url).toMatch(/\/v1\/broker\/audit$/);
    expect(calls[0].body).toMatchObject({ action: "create_issue", outcome: "allowed" });
  });
});

describe("agentvalet approval provider", () => {
  const noSleep = async () => {};
  it("creates a request then polls until approved", async () => {
    let polls = 0;
    const { fetch, calls } = recorder((c) => {
      if (c.method === "POST") return { body: { id: "apr_1" } };
      polls++;
      return { body: { status: polls < 2 ? "pending" : "approved" } };
    });
    const prov = new AgentvaletApprovalProvider({ token: "t", fetch, pollMs: 1, sleep: noSleep });
    const result = await prov.request(req, allow);
    expect(result).toEqual({ approved: true });
    expect(calls[0].url).toMatch(/\/v1\/broker\/approvals$/);
    expect(calls[1].url).toMatch(/\/v1\/broker\/approvals\/apr_1$/);
  });

  it("returns declined on a denied status", async () => {
    const { fetch } = recorder((c) => (c.method === "POST" ? { body: { id: "a" } } : { body: { status: "denied" } }));
    const prov = new AgentvaletApprovalProvider({ token: "t", fetch, pollMs: 1, sleep: noSleep });
    expect(await prov.request(req, allow)).toEqual({ approved: false, reason: "declined" });
  });

  it("times out (deny) when the deadline passes without a decision", async () => {
    let clock = 0;
    const { fetch } = recorder((c) => (c.method === "POST" ? { body: { id: "a" } } : { body: { status: "pending" } }));
    const prov = new AgentvaletApprovalProvider({
      token: "t",
      fetch,
      pollMs: 10,
      timeoutMs: 30,
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
    });
    expect(await prov.request(req, allow)).toEqual({ approved: false, reason: "timeout" });
  });
});
