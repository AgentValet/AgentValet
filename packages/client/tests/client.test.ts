import { describe, it, expect, beforeAll, vi } from "vitest";
import { generateKeyPair, exportPKCS8, decodeJwt, decodeProtectedHeader } from "jose";
import {
  AgentValet,
  AccessDeniedError,
  ApprovalDeniedError,
  ApprovalExpiredError,
  ApprovalTimeoutError,
  ConfigError,
  NetworkError,
  ProxyError,
  UpstreamError,
} from "../src/index.js";

let PEM: string;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  PEM = await exportPKCS8(privateKey);
});

/** Queues canned responses; records every request for assertions. */
function stubFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const queue = [...responses];
  const doFetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error(`stubFetch: no response queued for ${url}`);
    const text = typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    return new Response(text, { status: next.status, headers: { "Content-Type": "application/json" } });
  });
  return { doFetch, calls };
}

function makeClient(doFetch: ReturnType<typeof stubFetch>["doFetch"], overrides = {}) {
  return new AgentValet({
    agentId: "agt_test",
    ownerId: "own_test",
    privateKey: PEM,
    proxyUrl: "https://api.example.test",
    fetch: doFetch,
    approvalPollMs: 1,
    approvalTimeoutMs: 50,
    ...overrides,
  });
}

describe("construction", () => {
  it("rejects a missing agentId, ownerId, or privateKey", () => {
    expect(() => new AgentValet({ agentId: "", ownerId: "o", privateKey: PEM })).toThrow(ConfigError);
    expect(() => new AgentValet({ agentId: "a", ownerId: "", privateKey: PEM })).toThrow(ConfigError);
    expect(() => new AgentValet({ agentId: "a", ownerId: "o", privateKey: "" })).toThrow(ConfigError);
  });

  it("defaults to the hosted proxy and strips a trailing slash", () => {
    expect(new AgentValet({ agentId: "a", ownerId: "o", privateKey: PEM }).proxyUrl)
      .toBe("https://api.agentvalet.ai");
    expect(
      new AgentValet({ agentId: "a", ownerId: "o", privateKey: PEM, proxyUrl: "https://x.test/" }).proxyUrl,
    ).toBe("https://x.test");
  });

  it("fromEnv throws a ConfigError naming the vars when identity is absent", () => {
    vi.stubEnv("AGENTVALET_AGENT_ID", "");
    vi.stubEnv("AGENT_ID", "");
    vi.stubEnv("AGENTVALET_OWNER_ID", "");
    vi.stubEnv("OWNER_ID", "");
    expect(() => AgentValet.fromEnv()).toThrow(/AGENTVALET_AGENT_ID/);
    vi.unstubAllEnvs();
  });
});

describe("signJWT", () => {
  it("mints an RS256 assertion carrying agent_id and owner_id", async () => {
    const { doFetch } = stubFetch([]);
    const token = await makeClient(doFetch).signJWT();
    expect(decodeProtectedHeader(token).alg).toBe("RS256");
    const claims = decodeJwt(token);
    expect(claims.agent_id).toBe("agt_test");
    expect(claims.owner_id).toBe("own_test");
    // Short-lived: the proxy rejects long-dated agent assertions.
    expect((claims.exp as number) - (claims.iat as number)).toBe(60);
  });

  it("surfaces a malformed key as ConfigError, not a raw jose error", async () => {
    const { doFetch } = stubFetch([]);
    const c = makeClient(doFetch, { privateKey: "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----" });
    await expect(c.signJWT()).rejects.toThrow(ConfigError);
  });
});

describe("call", () => {
  it("returns the upstream body and sends a bearer token", async () => {
    const { doFetch, calls } = stubFetch([{ status: 200, body: { ok: true, ts: "1" } }]);
    const out = await makeClient(doFetch).call({
      platform: "slack",
      endpoint: "/api/chat.postMessage",
      method: "POST",
      scope: "chat:write",
      data: { channel: "#general", text: "hi" },
    });

    expect(out).toEqual({ ok: true, ts: "1" });
    expect(calls[0].url).toBe("https://api.example.test/v1/actions");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Bearer ey/);
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({
      platform: "slack",
      scope: "chat:write",
      method: "POST",
      data: { channel: "#general", text: "hi" },
    });
  });

  it("defaults method to GET and omits absent optional fields", async () => {
    const { doFetch, calls } = stubFetch([{ status: 200, body: {} }]);
    await makeClient(doFetch).call({ platform: "github", endpoint: "/user", scope: "read" });
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.method).toBe("GET");
    expect(body).not.toHaveProperty("data");
    expect(body).not.toHaveProperty("connection_id");
    expect(body).not.toHaveProperty("reason");
  });

  it("forwards connectionId and reason under their wire names", async () => {
    const { doFetch, calls } = stubFetch([{ status: 200, body: {} }]);
    await makeClient(doFetch).call({
      platform: "slack", endpoint: "/x", scope: "s", connectionId: "conn_1", reason: "weekly digest",
    });
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({
      connection_id: "conn_1",
      reason: "weekly digest",
    });
  });

  it("maps 403 to AccessDeniedError pointing at requestAccess", async () => {
    const { doFetch } = stubFetch([{ status: 403, body: { error: "scope not granted" } }]);
    const err = await makeClient(doFetch)
      .call({ platform: "stripe", endpoint: "/v1/charges", scope: "charge" })
      .catch((e) => e);

    expect(err).toBeInstanceOf(AccessDeniedError);
    expect(err.platform).toBe("stripe");
    expect(err.scope).toBe("charge");
    expect(err.message).toMatch(/requestAccess/);
  });

  it("maps other non-2xx to ProxyError carrying status and body", async () => {
    const { doFetch } = stubFetch([{ status: 500, body: "boom" }]);
    const err = await makeClient(doFetch)
      .call({ platform: "p", endpoint: "/e", scope: "s" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProxyError);
    expect(err.status).toBe(500);
  });

  it("retries exactly once on 401, then returns the retry's result", async () => {
    const { doFetch, calls } = stubFetch([
      { status: 401, body: { error: "clock skew" } },
      { status: 200, body: { ok: true } },
    ]);
    const out = await makeClient(doFetch).call({ platform: "p", endpoint: "/e", scope: "s" });
    expect(out).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("wraps a transport failure as NetworkError with an actionable hint", async () => {
    const doFetch = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND api.example.test");
    });
    const err = await makeClient(doFetch as never)
      .call({ platform: "p", endpoint: "/e", scope: "s" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.message).toMatch(/Cannot resolve/);
  });
});

describe("approval long-poll", () => {
  const approval = (over: Record<string, unknown> = {}) => ({
    approval_id: "apr_1",
    status: "pending",
    expires_at: "",
    executed_at: null,
    created_at: "",
    ...over,
  });

  it("waits out a 202 and returns the re-executed upstream result transparently", async () => {
    const { doFetch, calls } = stubFetch([
      { status: 202, body: { approval_id: "apr_1" } },
      { status: 200, body: approval() },
      { status: 200, body: approval({ status: "approved", executed_at: "now", result: { status: 200, data: { sent: true } } }) },
    ]);

    const out = await makeClient(doFetch).call({ platform: "slack", endpoint: "/x", scope: "chat:write" });

    expect(out).toEqual({ sent: true });
    expect(calls[1].url).toBe("https://api.example.test/v1/approvals/apr_1");
  });

  it("throws ApprovalDeniedError when the owner denies", async () => {
    const { doFetch } = stubFetch([
      { status: 202, body: { approval_id: "apr_1" } },
      { status: 200, body: approval({ status: "denied" }) },
    ]);
    const err = await makeClient(doFetch).call({ platform: "p", endpoint: "/e", scope: "s" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApprovalDeniedError);
    expect(err.approvalId).toBe("apr_1");
  });

  it("throws ApprovalExpiredError when the request ages out server-side", async () => {
    const { doFetch } = stubFetch([
      { status: 202, body: { approval_id: "apr_1" } },
      { status: 200, body: approval({ status: "expired" }) },
    ]);
    await expect(
      makeClient(doFetch).call({ platform: "p", endpoint: "/e", scope: "s" }),
    ).rejects.toBeInstanceOf(ApprovalExpiredError);
  });

  it("throws UpstreamError when the approved call executes but the SaaS 4xxs", async () => {
    const { doFetch } = stubFetch([
      { status: 202, body: { approval_id: "apr_1" } },
      { status: 200, body: approval({ status: "approved", executed_at: "now", result: { status: 422, data: { err: "bad" } } }) },
    ]);
    const err = await makeClient(doFetch).call({ platform: "p", endpoint: "/e", scope: "s" }).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(422);
  });

  it("throws ApprovalTimeoutError carrying a resumable approvalId", async () => {
    const many = Array.from({ length: 200 }, () => ({ status: 200, body: approval() }));
    const { doFetch } = stubFetch([{ status: 202, body: { approval_id: "apr_1" } }, ...many]);
    const err = await makeClient(doFetch, { approvalTimeoutMs: 20 })
      .call({ platform: "p", endpoint: "/e", scope: "s" })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ApprovalTimeoutError);
    expect(err.approvalId).toBe("apr_1");
    expect(err.message).toMatch(/waitForApproval/);
  });

  it("waitForApproval resumes an outstanding approval by id", async () => {
    const { doFetch, calls } = stubFetch([
      { status: 200, body: approval({ status: "approved", executed_at: "now", result: { status: 200, data: { late: true } } }) },
    ]);
    const out = await makeClient(doFetch).waitForApproval("apr_9");
    expect(out).toEqual({ late: true });
    expect(calls[0].url).toBe("https://api.example.test/v1/approvals/apr_9");
  });

  it("reports progress to onApprovalPending while waiting", async () => {
    const seen: number[] = [];
    const { doFetch } = stubFetch([
      { status: 202, body: { approval_id: "apr_1" } },
      { status: 200, body: approval() },
      { status: 200, body: approval({ status: "approved", executed_at: "now", result: { status: 200, data: 1 } }) },
    ]);
    await makeClient(doFetch, {
      onApprovalPending: (i: { elapsedMs: number }) => seen.push(i.elapsedMs),
    }).call({ platform: "slack", endpoint: "/x", scope: "chat:write" });
    expect(seen.length).toBeGreaterThan(0);
  });
});

describe("discovery and governance", () => {
  it("listPlatforms hits the permissions endpoint", async () => {
    const { doFetch, calls } = stubFetch([{ status: 200, body: { platforms: [] } }]);
    await makeClient(doFetch).listPlatforms();
    expect(calls[0].url).toBe("https://api.example.test/v1/agent/permissions");
  });

  it("pendingActions hits the agent pending-actions endpoint", async () => {
    const { doFetch, calls } = stubFetch([{ status: 200, body: [] }]);
    await makeClient(doFetch).pendingActions();
    expect(calls[0].url).toBe("https://api.example.test/v1/agents/me/pending-actions");
  });

  it("evaluate posts a well-formed AuthZEN subject/action/resource triple", async () => {
    const { doFetch, calls } = stubFetch([{ status: 200, body: { decision: false } }]);
    await makeClient(doFetch).evaluate("stripe", "charge");
    expect(calls[0].url).toBe("https://api.example.test/v1/authzen/access");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      subject: { type: "agent", id: "agt_test" },
      action: { name: "tool_call" },
      resource: { type: "platform_scope", id: "stripe:charge" },
    });
  });

  it("requestAccess submits then polls to an approved decision", async () => {
    const { doFetch, calls } = stubFetch([
      { status: 202, body: { request_token: "req_1" } },
      { status: 200, body: { status: "pending" } },
      { status: 200, body: { status: "approved" } },
    ]);
    const out = await makeClient(doFetch).requestAccess({ platform: "slack", scope: "chat:write", reason: "digest" });
    expect(out).toEqual({ status: "approved", requestToken: "req_1" });
    expect(calls[0].url).toBe("https://api.example.test/v1/access-request");
    expect(calls[1].url).toBe("https://api.example.test/v1/access-request/status/req_1");
  });

  it("requestAccess returns pending when nobody decides within the budget", async () => {
    const many = Array.from({ length: 200 }, () => ({ status: 200, body: { status: "pending" } }));
    const { doFetch } = stubFetch([{ status: 202, body: { request_token: "req_1" } }, ...many]);
    const out = await makeClient(doFetch, { approvalTimeoutMs: 20 }).requestAccess({ platform: "slack" });
    expect(out.status).toBe("pending");
  });
});
