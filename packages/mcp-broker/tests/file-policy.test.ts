// The file: policy source must decide via the SAME kernel the hosted plane
// runs. These tests pin the translation from the tool-centric YAML to the
// kernel's allow / deny / require_approval verdicts.
import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilePolicySource } from "../src/policy/file-source.js";
import type { AccessRequest } from "../src/types.js";

function tmp(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-broker-pol-"));
  const p = join(dir, "policy.yaml");
  writeFileSync(p, body, "utf8");
  return p;
}

const req = (tool: string): AccessRequest => ({
  subject: { id: "a", sessionId: "s" },
  action: { name: tool },
  resource: { server: "github-tools", tool },
  context: { argsFingerprint: "sha256:0", transport: "stdio", ts: "2026-07-04T00:00:00.000Z" },
});

const DENY_DEFAULT = `version: 1
defaults:
  effect: deny
rules:
  - tool: create_issue
    effect: allow
    credential: github_issues_rw
  - tool: delete_repo
    effect: require_approval
    credential: github_admin
  - tool: blocked_tool
    effect: deny
`;

describe("file policy source", () => {
  it("allows a listed allow tool and carries its credential obligation", async () => {
    const d = await new FilePolicySource(tmp(DENY_DEFAULT)).evaluate(req("create_issue"));
    expect(d.effect).toBe("allow");
    expect(d.obligations).toEqual([{ type: "credential", ref: "github_issues_rw" }]);
  });

  it("returns require_approval for a require_approval tool", async () => {
    const d = await new FilePolicySource(tmp(DENY_DEFAULT)).evaluate(req("delete_repo"));
    expect(d.effect).toBe("require_approval");
    expect(d.obligations).toEqual([{ type: "credential", ref: "github_admin" }]);
  });

  it("denies an unlisted tool under defaults.effect deny", async () => {
    const d = await new FilePolicySource(tmp(DENY_DEFAULT)).evaluate(req("unlisted"));
    expect(d.effect).toBe("deny");
    expect(d.obligations).toEqual([]);
  });

  it("denies an explicit deny tool", async () => {
    const d = await new FilePolicySource(tmp(DENY_DEFAULT)).evaluate(req("blocked_tool"));
    expect(d.effect).toBe("deny");
  });

  it("allows an unlisted tool under defaults.effect allow", async () => {
    const doc = `version: 1
defaults:
  effect: allow
rules:
  - tool: dangerous
    effect: deny
`;
    const src = new FilePolicySource(tmp(doc));
    expect((await src.evaluate(req("anything"))).effect).toBe("allow");
    expect((await src.evaluate(req("dangerous"))).effect).toBe("deny");
  });

  it("throws when the policy file is unreachable (pipeline turns this into deny)", async () => {
    await expect(new FilePolicySource("/no/such/policy.yaml").evaluate(req("x"))).rejects.toThrow();
  });
});
