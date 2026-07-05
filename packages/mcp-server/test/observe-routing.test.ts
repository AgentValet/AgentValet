import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleUsePlatform } from "../src/tools/handlers.js";

// fetchWithAuth calls signJWT (jose RS256) which requires a real CryptoKey.
// In unit tests we stub global fetch instead, so we must mock fetchWithAuth to
// bypass JWT signing while still delegating the actual network call to global
// fetch — which lets us assert on the URL + headers without a real key.
vi.mock("../src/auth.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/auth.js")>();
  return {
    ...orig,
    fetchWithAuth: vi.fn(async (_ctx: unknown, url: string, init: RequestInit) => {
      return fetch(url, { ...init, headers: { Authorization: "Bearer stub", "Content-Type": "application/json", ...init.headers } });
    }),
  };
});

function ctx(observe?: { platform: string; credential: string }) {
  return {
    PROXY_URL: "https://proxy.test",
    AGENT_ID: "agt_obs",
    OWNER_ID: "owner_obs",
    AGENT_PRIVATE_KEY_RAW: "rawkey",
    OBSERVE_PLATFORM: observe?.platform ?? "",
    OBSERVE_CREDENTIAL: observe?.credential ?? "",
    privateKey: {} as never,
    server: {} as never,
  } as never;
}

beforeEach(() => vi.restoreAllMocks());

describe("handleUsePlatform observe routing", () => {
  it("routes to /v1/observe/actions with the credential header in observe mode", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await handleUsePlatform(
      ctx({ platform: "github", credential: "sk_secret" }),
      { platform: "github", endpoint: "/user", method: "GET", scope: "repo:read" },
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://proxy.test/v1/observe/actions");
    expect((init.headers as Record<string, string>)["X-AV-Observe-Credential"]).toBe("sk_secret");
    // AV agent JWT must be sent on the observe request (proxy requires it)
    expect((init.headers as Record<string, string>)["Authorization"]).toMatch(/^Bearer /);
    // credential is NOT in the JSON body the model sees
    expect(init.body as string).not.toContain("sk_secret");
    expect(JSON.stringify(res)).toContain("ok");
  });

  it("routes to /v1/actions (governed) when no observe credential is set", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await handleUsePlatform(ctx(), { platform: "github", endpoint: "/user", method: "GET", scope: "repo:read" });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://proxy.test/v1/actions");
  });

  it("routes to observe when OBSERVE_PLATFORM matches the requested platform", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await handleUsePlatform(
      ctx({ platform: "github", credential: "sk_gh" }),
      { platform: "github", endpoint: "/repos", method: "GET", scope: "repo:read" },
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://proxy.test/v1/observe/actions");
    expect((init.headers as Record<string, string>)["X-AV-Observe-Credential"]).toBe("sk_gh");
  });

  it("falls through to governed path when OBSERVE_PLATFORM is set but platform does NOT match", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    // Observe configured for "github" but the call is for "stripe" — must NOT leak credential
    await handleUsePlatform(
      ctx({ platform: "github", credential: "sk_gh" }),
      { platform: "stripe", endpoint: "/charges", method: "GET", scope: "stripe:read" },
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // Must go to the governed /v1/actions path, not the observe relay
    expect(url).toBe("https://proxy.test/v1/actions");
    // BYO credential must NOT appear on the wrong platform's request
    expect(JSON.stringify(init.headers ?? {})).not.toContain("sk_gh");
  });

  it("routes to observe for any platform when OBSERVE_CREDENTIAL is set but OBSERVE_PLATFORM is empty", async () => {
    // Build a ctx with credential but empty platform (backwards-compat)
    const broadCtx = {
      PROXY_URL: "https://proxy.test",
      AGENT_ID: "agt_obs",
      OWNER_ID: "owner_obs",
      AGENT_PRIVATE_KEY_RAW: "rawkey",
      OBSERVE_PLATFORM: "",
      OBSERVE_CREDENTIAL: "sk_any",
      privateKey: {} as never,
      server: {} as never,
    } as never;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await handleUsePlatform(
      broadCtx,
      { platform: "slack", endpoint: "/chat.postMessage", method: "POST", scope: "chat:write" },
    );
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://proxy.test/v1/observe/actions");
  });
});
