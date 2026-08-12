import { describe, it, expect, afterEach, vi } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentIdFromEnv, proxyUrlFromEnv, privateKeyFromEnv, DEFAULT_PROXY_URL } from "../src/env.js";
import { ConfigError } from "../src/errors.js";

afterEach(() => vi.unstubAllEnvs());

/** Blank every name env.ts consults so a stray real env var can't leak in. */
function clearIdentity() {
  for (const n of ["AGENTVALET_AGENT_ID", "AGENT_ID", "AGENTVALET_OWNER_ID", "OWNER_ID",
    "AGENTVALET_PROXY_URL", "PROXY_URL", "AGENTVALET_AGENT_PRIVATE_KEY", "AGENT_PRIVATE_KEY",
    "AGENTVALET_AGENT_PRIVATE_KEY_B64", "AGENT_PRIVATE_KEY_B64",
    "AGENTVALET_AGENT_PRIVATE_KEY_PATH", "AGENT_PRIVATE_KEY_PATH"]) {
    vi.stubEnv(n, "");
  }
}

describe("identity resolution", () => {
  it("prefers the AGENTVALET_-prefixed name over the bare one", () => {
    clearIdentity();
    vi.stubEnv("AGENT_ID", "agt_bare");
    vi.stubEnv("AGENTVALET_AGENT_ID", "agt_prefixed");
    expect(agentIdFromEnv()).toBe("agt_prefixed");
  });

  it("falls back to the bare name the MCPB and CLI write", () => {
    clearIdentity();
    vi.stubEnv("AGENT_ID", "agt_bare");
    expect(agentIdFromEnv()).toBe("agt_bare");
  });

  // The MCPB writes a literal "${user_config.x}" when a field is left blank.
  // Treating that as a real value produces a baffling 401 much later.
  it("treats an unresolved MCPB placeholder as not-set", () => {
    clearIdentity();
    vi.stubEnv("AGENT_ID", "${user_config.agent_id}");
    expect(agentIdFromEnv()).toBeNull();
  });

  it("defaults the proxy URL and strips a trailing slash", () => {
    clearIdentity();
    expect(proxyUrlFromEnv()).toBe(DEFAULT_PROXY_URL);
    vi.stubEnv("PROXY_URL", "https://self.hosted.test/");
    expect(proxyUrlFromEnv()).toBe("https://self.hosted.test");
  });
});

describe("private key resolution", () => {
  const PEM = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----";

  it("reads base64 first", () => {
    clearIdentity();
    vi.stubEnv("AGENT_PRIVATE_KEY_B64", Buffer.from(PEM).toString("base64"));
    expect(privateKeyFromEnv()).toBe(PEM);
  });

  it("reads a PEM file by path", () => {
    clearIdentity();
    const p = join(mkdtempSync(join(tmpdir(), "av-")), "agent.key");
    writeFileSync(p, PEM);
    vi.stubEnv("AGENT_PRIVATE_KEY_PATH", p);
    expect(privateKeyFromEnv()).toBe(PEM);
  });

  it("raises ConfigError naming the path when the file is unreadable", () => {
    clearIdentity();
    vi.stubEnv("AGENT_PRIVATE_KEY_PATH", join(tmpdir(), "definitely-not-here-av.key"));
    expect(() => privateKeyFromEnv()).toThrow(ConfigError);
  });

  it("unescapes a \\n-collapsed single-line PEM", () => {
    clearIdentity();
    vi.stubEnv("AGENT_PRIVATE_KEY", "-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----");
    expect(privateKeyFromEnv()).toBe(PEM);
  });

  // Secrets UIs routinely trim the PEM armour on paste.
  it("re-wraps a bare base64 blob that lost its PEM armour", () => {
    clearIdentity();
    vi.stubEnv("AGENT_PRIVATE_KEY", "AAAA");
    expect(privateKeyFromEnv()).toBe(PEM);
  });
});
