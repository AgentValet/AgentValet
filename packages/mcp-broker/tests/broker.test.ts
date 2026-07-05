// End-to-end: a wrapped MCP server driven through a real client over an
// in-memory transport. Proves the enforcement pipeline runs on the actual MCP
// call path, not just when a handler is poked directly.
import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { broker } from "../src/broker.js";
import { FilePolicySource } from "../src/policy/file-source.js";
import { EnvSecretSource } from "../src/secrets/env-source.js";
import { MemoryAuditSink } from "../src/audit/jsonl-sink.js";
import type { AccessRequest, ApprovalProvider, Credential, Decision, PolicySource } from "../src/types.js";

const POLICY = `version: 1
defaults:
  effect: deny
rules:
  - tool: create_issue
    effect: allow
    credential: github_issues_rw
  - tool: delete_repo
    effect: require_approval
    credential: github_admin
`;

function tmpPolicy(body = POLICY): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-broker-"));
  const p = join(dir, "policy.yaml");
  writeFileSync(p, body, "utf8");
  return p;
}

interface Harness {
  client: Client;
  audit: MemoryAuditSink;
  seen: { credential?: Credential };
  close: () => Promise<void>;
}

async function harness(opts: {
  policy: PolicySource | string;
  secrets?: EnvSecretSource;
  approval?: ApprovalProvider;
  failMode?: "closed" | "open";
}): Promise<Harness> {
  const server = new McpServer({ name: "github-tools", version: "1.0.0" });
  const audit = new MemoryAuditSink();
  const seen: { credential?: Credential } = {};

  broker(server, {
    policy: opts.policy,
    secrets: opts.secrets ?? new EnvSecretSource("", { GITHUB_ISSUES_RW: "ghp_rw", GITHUB_ADMIN: "ghp_admin" }),
    audit,
    ...(opts.approval ? { approval: opts.approval } : {}),
    failMode: opts.failMode ?? "closed",
  });

  server.registerTool(
    "create_issue",
    { description: "create issue", inputSchema: { title: z.string() } },
    async (args: { title: string }, ctx: { credential?: Credential }) => {
      seen.credential = ctx.credential;
      return { content: [{ type: "text" as const, text: `made ${args.title}` }] };
    },
  );
  server.registerTool(
    "delete_repo",
    { description: "delete repo", inputSchema: { name: z.string() } },
    async () => ({ content: [{ type: "text" as const, text: "deleted" }] }),
  );
  server.registerTool(
    "secret_tool",
    { description: "not in policy", inputSchema: {} },
    async () => ({ content: [{ type: "text" as const, text: "ran" }] }),
  );

  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, audit, seen, close: () => client.close() };
}

describe("broker enforcement (integration)", () => {
  it("denies a tool with no matching allow rule by default (failMode closed)", async () => {
    const h = await harness({ policy: new FilePolicySource(tmpPolicy()) });
    const res = (await h.client.callTool({ name: "secret_tool", arguments: {} })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(h.seen.credential).toBeUndefined();
    const ev = h.audit.events.at(-1)!;
    expect(ev.outcome).toBe("denied");
    expect(ev.decision.effect).toBe("deny");
    expect(ev.resource.server).toBe("github-tools");
    await h.close();
  });

  it("allows an allowed tool, injects the narrow credential, never the raw ref", async () => {
    const h = await harness({ policy: new FilePolicySource(tmpPolicy()) });
    const res = (await h.client.callTool({ name: "create_issue", arguments: { title: "bug" } })) as {
      content: Array<{ text: string }>;
    };
    expect(res.content[0].text).toBe("made bug");
    expect(h.seen.credential?.token).toBe("ghp_rw");
    // The handler's ctx.credential is a resolved Credential, never a CredentialRef.
    expect(h.seen.credential).not.toHaveProperty("id");
    expect(h.seen.credential).not.toHaveProperty("ref");
    const ev = h.audit.events.at(-1)!;
    expect(ev.outcome).toBe("allowed");
    expect(ev.argsFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Static env secret: the audit warns about the missing expiry.
    expect(ev.warnings).toContain("credential_no_expiry_static_secret");
    await h.close();
  });

  it("narrows credential scope from decision obligations", async () => {
    // A policy source that attaches both a credential ref and a narrow_scope.
    const narrowing: PolicySource = {
      async evaluate(req: AccessRequest): Promise<Decision> {
        return {
          effect: "allow",
          policyId: "test",
          version: "1",
          obligations: [
            { type: "credential", ref: "github_issues_rw" },
            { type: "narrow_scope", scope: ["issues:write"] },
          ],
        };
      },
    };
    const h = await harness({ policy: narrowing });
    await h.client.callTool({ name: "create_issue", arguments: { title: "x" } });
    expect(h.seen.credential?.scope).toEqual(["issues:write"]);
    expect(h.audit.events.at(-1)!.credentialScope).toEqual(["issues:write"]);
    await h.close();
  });

  it("require_approval blocks until the provider approves", async () => {
    const approve: ApprovalProvider = { async request() { return { approved: true }; } };
    const h = await harness({ policy: new FilePolicySource(tmpPolicy()), approval: approve });
    const res = (await h.client.callTool({ name: "delete_repo", arguments: { name: "r" } })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toBe("deleted");
    expect(h.audit.events.at(-1)!.outcome).toBe("allowed");
    await h.close();
  });

  it("denies and audits approval_timeout when the provider times out", async () => {
    const timeout: ApprovalProvider = { async request() { return { approved: false, reason: "timeout" }; } };
    const h = await harness({ policy: new FilePolicySource(tmpPolicy()), approval: timeout });
    const res = (await h.client.callTool({ name: "delete_repo", arguments: { name: "r" } })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(h.audit.events.at(-1)!.outcome).toBe("approval_timeout");
    await h.close();
  });

  it("denies require_approval when no approval provider is configured", async () => {
    const h = await harness({ policy: new FilePolicySource(tmpPolicy()) });
    const res = (await h.client.callTool({ name: "delete_repo", arguments: { name: "r" } })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(h.audit.events.at(-1)!.outcome).toBe("approval_denied");
    await h.close();
  });
});
