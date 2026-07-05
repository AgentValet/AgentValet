// apps/mcp-server/test/gate-client.test.ts
//
// The gate client wraps the public governance contract (POST /v1/actions and
// the Observe relay POST /v1/observe/actions). It maps every wire response to
// exactly one of the six documented decisions so a connector can switch on a
// single discriminated union instead of re-deriving status-code semantics.
//
// Two layers are tested:
//   1. classifyGateResponse — the pure status+body → decision mapper.
//   2. callGate / observe — the thin fetch wrappers (fetch injected).
// Plus a contract-conformance block that drives EACH decision value through
// the wrapper using the exact response shapes the proxy emits today.

import { describe, it, expect, vi } from "vitest";
import { classifyGateResponse, callGate, observe } from "../src/gate-client.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("classifyGateResponse", () => {
  it("maps a 2xx body to allowed and carries the upstream data", () => {
    const out = classifyGateResponse(200, { ok: true, id: 7 });
    expect(out.decision).toBe("allowed");
    if (out.decision === "allowed") expect(out.data).toMatchObject({ id: 7 });
  });

  it("maps 202 to pending_approval and surfaces the approval id", () => {
    const out = classifyGateResponse(202, { status: "pending_approval", approval_id: "apr_1" });
    expect(out.decision).toBe("pending_approval");
    if (out.decision === "pending_approval") expect(out.approvalId).toBe("apr_1");
  });

  it("maps a 403 permission denial to denied with the reason", () => {
    const out = classifyGateResponse(403, { error: "Permission denied", reason: "scope_not_granted" });
    expect(out.decision).toBe("denied");
    if (out.decision === "denied") expect(out.reason).toBe("scope_not_granted");
  });

  it("maps 412 platform_not_connected to denied", () => {
    const out = classifyGateResponse(412, { error: "platform_not_connected", code: "no_credential" });
    expect(out.decision).toBe("denied");
  });

  it("maps 402 billing refusals to denied", () => {
    expect(classifyGateResponse(402, { error: "plan_inactive" }).decision).toBe("denied");
  });

  it("maps a circuit-breaker / suspended agent (403) to suspended, not denied", () => {
    expect(classifyGateResponse(403, { error: "Permission denied", reason: "agent_suspended" }).decision)
      .toBe("suspended");
    expect(classifyGateResponse(403, { error: "Permission denied", reason: "circuit_breaker_open" }).decision)
      .toBe("suspended");
  });

  it("maps a 5xx upstream failure to error and carries the code + correlation id", () => {
    const out = classifyGateResponse(502, {
      error: "Upstream authentication failed",
      code: "reauth_failed",
      correlation_id: "corr_9",
    });
    expect(out.decision).toBe("error");
    if (out.decision === "error") {
      expect(out.code).toBe("reauth_failed");
      expect(out.correlationId).toBe("corr_9");
    }
  });

  it("maps a 401 identity rejection to error", () => {
    expect(classifyGateResponse(401, { error: "Invalid JWT" }).decision).toBe("error");
  });
});

describe("callGate", () => {
  const client = { proxyUrl: "https://api.test", token: "jwt" };

  it("returns allowed for a 2xx and sends a signed Bearer to /v1/actions", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { data: { value: 1 } }));
    const out = await callGate({ ...client, fetchImpl }, {
      platform: "github", endpoint: "/user", method: "GET", scope: "repo:read",
    });
    expect(out.decision).toBe("allowed");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.test/v1/actions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt");
  });

  it("returns denied for a 403", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(403, { error: "Permission denied", reason: "no_policy_assigned" }));
    const out = await callGate({ ...client, fetchImpl }, {
      platform: "slack", endpoint: "/chat.postMessage", method: "POST", scope: "chat:write",
    });
    expect(out.decision).toBe("denied");
    if (out.decision === "denied") expect(out.reason).toBe("no_policy_assigned");
  });

  it("returns pending_approval for a 202", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(202, { status: "pending_approval", approval_id: "apr_42" }));
    const out = await callGate({ ...client, fetchImpl }, {
      platform: "stripe", endpoint: "/v1/refunds", method: "POST", scope: "stripe:refund",
    });
    expect(out.decision).toBe("pending_approval");
    if (out.decision === "pending_approval") expect(out.approvalId).toBe("apr_42");
  });

  it("returns error (not a throw) when the transport fails", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const out = await callGate({ ...client, fetchImpl }, {
      platform: "github", endpoint: "/user", method: "GET", scope: "repo:read",
    });
    expect(out.decision).toBe("error");
    if (out.decision === "error") expect(out.code).toBe("network_error");
  });
});

describe("observe", () => {
  const client = { proxyUrl: "https://api.test", token: "jwt" };

  it("returns observed for a relayed response and never puts the credential in the body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { login: "octocat" }));
    const out = await observe({ ...client, fetchImpl }, {
      platform: "github", endpoint: "/user", method: "GET", credential: "sk_secret",
    });
    expect(out.decision).toBe("observed");
    if (out.decision === "observed") expect(out.data).toMatchObject({ login: "octocat" });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.test/v1/observe/actions");
    // Credential rides as a header, NOT in the model-visible request body.
    expect((init.headers as Record<string, string>)["X-AV-Observe-Credential"]).toBe("sk_secret");
    expect(init.body as string).not.toContain("sk_secret");
  });

  it("returns observed even when the relayed upstream status is non-2xx", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error: "upstream boom" }));
    const out = await observe({ ...client, fetchImpl }, {
      platform: "github", endpoint: "/user", method: "GET", credential: "sk_secret",
    });
    expect(out.decision).toBe("observed");
    if (out.decision === "observed") expect(out.status).toBe(500);
  });

  it("returns error when the transport fails", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("network down"); });
    const out = await observe({ ...client, fetchImpl }, {
      platform: "github", endpoint: "/user", method: "GET", credential: "sk_secret",
    });
    expect(out.decision).toBe("error");
  });
});

// Contract conformance: drive EACH of the six decision values through the
// public surface using the exact response shapes the proxy emits today. If the
// proxy's wire contract changes shape, one of these fails and the doc is stale.
describe("public-contract conformance — every decision value", () => {
  const client = { proxyUrl: "https://api.test", token: "jwt" };
  const req = { platform: "github", endpoint: "/user", method: "GET", scope: "repo:read" } as const;

  const cases: { name: string; status: number; body: unknown; expected: string }[] = [
    { name: "allowed", status: 200, body: { data: { ok: true } }, expected: "allowed" },
    { name: "pending_approval", status: 202, body: { status: "pending_approval", approval_id: "apr_1", message: "Owner approval required" }, expected: "pending_approval" },
    { name: "denied", status: 403, body: { error: "Permission denied", reason: "scope_not_granted", correlation_id: "c1" }, expected: "denied" },
    { name: "suspended", status: 403, body: { error: "Permission denied", reason: "agent_suspended" }, expected: "suspended" },
    { name: "error", status: 502, body: { error: "Upstream request failed", correlation_id: "c2" }, expected: "error" },
  ];

  for (const c of cases) {
    it(`${c.name} -> decision '${c.expected}' via callGate`, async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(c.status, c.body));
      const out = await callGate({ ...client, fetchImpl }, req);
      expect(out.decision).toBe(c.expected);
    });
  }

  it("observed -> decision 'observed' via observe()", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { relayed: true }));
    const out = await observe({ ...client, fetchImpl }, {
      platform: "github", endpoint: "/user", method: "GET", credential: "sk",
    });
    expect(out.decision).toBe("observed");
  });
});
