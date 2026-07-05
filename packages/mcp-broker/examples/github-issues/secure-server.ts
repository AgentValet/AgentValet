// AFTER: the same server, fixed with the three-line broker adoption.
//
// The diff from insecure-server.ts is small and that is the point:
//   1. import { broker } from "@agentvalet/mcp-broker"
//   2. broker(server, { policy, secrets, audit }) once, before registering tools
//   3. read ctx.credential.token in the handler instead of a module-level secret
//
// Now every tool is policy-checked (create_issue allowed, delete_repo needs
// approval, anything unlisted is denied), the token is resolved narrowly at call
// time and never lives in the handler's closure, and the audit records a
// fingerprint of the arguments rather than the arguments themselves.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { broker } from "@agentvalet/mcp-broker";

function githubClient(token: string) {
  return {
    issues: { create: (a: unknown) => ({ ok: true, sentWith: token, body: a }) },
    repos: { delete: (a: unknown) => ({ ok: true, sentWith: token, body: a }) },
  };
}

const server = new McpServer({ name: "github-tools", version: "1.0.0" });

// The three lines. policy.yaml lives next to this file; the token comes from an
// env var (GITHUB_ISSUES_RW / GITHUB_ADMIN) instead of the handler; audit is a
// JSONL file. Swap "env:"/"jsonl:" for "agentvalet:" to move to the hosted plane
// with no handler change.
broker(server, {
  policy: "file:./examples/github-issues/policy.yaml",
  secrets: "env:",
  audit: "jsonl:./examples/github-issues/fixtures/audit-after.jsonl",
});

server.tool(
  "create_issue",
  { title: z.string(), body: z.string() },
  async (args, ctx: { credential?: { token: string } }) => {
    const res = githubClient(ctx.credential!.token).issues.create(args);
    return { content: [{ type: "text", text: JSON.stringify(res) }] };
  },
);

server.tool(
  "delete_repo",
  { name: z.string() },
  async (args, ctx: { credential?: { token: string } }) => {
    const res = githubClient(ctx.credential!.token).repos.delete(args);
    return { content: [{ type: "text", text: JSON.stringify(res) }] };
  },
);

export { server };
