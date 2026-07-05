import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createCipheriv } from "node:crypto";

import { EnvSecretSource, envVarName } from "../src/secrets/env-source.js";
import { FileSecretSource, decryptSecretsFile } from "../src/secrets/file-source.js";
import type { CredentialRef, Decision } from "../src/types.js";

const allow: Decision = { effect: "allow", policyId: "p", version: "1" };
const narrowTo = (scope: string[]): Decision => ({ ...allow, obligations: [{ type: "narrow_scope", scope }] });

function tmpFile(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-broker-sec-"));
  const p = join(dir, name);
  writeFileSync(p, body, "utf8");
  return p;
}

describe("env secret source", () => {
  it("maps a ref id to an env var name with a prefix", () => {
    expect(envVarName("github_issues_rw", "")).toBe("GITHUB_ISSUES_RW");
    expect(envVarName("github-admin", "GH_")).toBe("GH_GITHUB_ADMIN");
  });

  it("resolves a token and stamps the narrowed scope from obligations", async () => {
    const src = new EnvSecretSource("", { GITHUB_ISSUES_RW: "ghp_x" });
    const cred = await src.resolve({ id: "github_issues_rw" }, narrowTo(["issues:write"]));
    expect(cred.token).toBe("ghp_x");
    expect(cred.scope).toEqual(["issues:write"]);
    expect(cred.expiresAt).toBeUndefined();
  });

  it("throws when the env var is missing (so the pipeline denies)", async () => {
    const src = new EnvSecretSource("", {});
    await expect(src.resolve({ id: "absent" }, allow)).rejects.toThrow(/ABSENT/);
  });
});

describe("file secret source", () => {
  it("resolves a bare token string entry", async () => {
    const p = tmpFile("secrets.json", JSON.stringify({ github_readonly: "ghp_ro" }));
    const cred = await new FileSecretSource(p).resolve({ id: "github_readonly" }, allow);
    expect(cred.token).toBe("ghp_ro");
  });

  it("resolves a structured entry and lets a decision scope override the file scope", async () => {
    const p = tmpFile(
      "secrets.json",
      JSON.stringify({ github_admin: { token: "ghp_a", scope: ["*"], expiresAt: "2027-01-01T00:00:00.000Z" } }),
    );
    const cred = await new FileSecretSource(p).resolve({ id: "github_admin" }, narrowTo(["repo:read"]));
    expect(cred.token).toBe("ghp_a");
    expect(cred.scope).toEqual(["repo:read"]);
    expect(cred.expiresAt?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("throws when the ref is not in the file", async () => {
    const p = tmpFile("secrets.json", JSON.stringify({ a: "1" }));
    await expect(new FileSecretSource(p).resolve({ id: "missing" }, allow)).rejects.toThrow(/missing/);
  });

  it("decrypts an AES-256-GCM encrypted secrets file with AGENTVALET_SECRETS_KEY", async () => {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const plaintext = JSON.stringify({ github_readonly: "ghp_encrypted" });
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob = `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;

    // Direct decrypt helper.
    expect(decryptSecretsFile(blob, key)).toBe(plaintext);

    // And through the source with the key in the injected env.
    const p = tmpFile("secrets.enc", blob);
    const src = new FileSecretSource(p, { AGENTVALET_SECRETS_KEY: key.toString("base64") });
    const cred = await src.resolve({ id: "github_readonly" } as CredentialRef, allow);
    expect(cred.token).toBe("ghp_encrypted");
  });
});
