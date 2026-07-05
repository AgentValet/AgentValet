// BEFORE: a deliberately naive MCP server. Do not copy this.
//
// Everything that is wrong with an ungoverned tool server is here on purpose:
//   - a raw personal access token sits in the handler's closure,
//   - every tool runs with no policy check, so delete_repo executes for anyone,
//   - the only "audit" is an ad-hoc log line that writes the raw token and the
//     raw arguments straight to disk.
//
// The fixed version (secure-server.ts) adds three lines and none of this is true
// any more. See examples/github-issues/README.md and the two audit logs under
// fixtures/ for the side by side.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appendFileSync } from "node:fs";

// A long-lived secret, in the process, in the handler. This is the thing the
// broker exists to take out of your server.
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "ghp_EXAMPLEonlyNotARealToken0123456789ab";

function githubClient(token: string) {
  // Stand-in for a real client. Returns what it would have sent.
  return {
    issues: { create: (a: unknown) => ({ ok: true, sentWith: token, body: a }) },
    repos: { delete: (a: unknown) => ({ ok: true, sentWith: token, body: a }) },
  };
}

// The naive "audit": a log line per call that happily records the token and the
// full arguments. This is the anti-pattern the broker's audit sink replaces.
function naiveLog(entry: Record<string, unknown>) {
  appendFileSync(new URL("./fixtures/audit-before.jsonl", import.meta.url), JSON.stringify(entry) + "\n");
}

const server = new McpServer({ name: "github-tools", version: "1.0.0" });

server.tool("create_issue", { title: z.string(), body: z.string() }, async (args) => {
  naiveLog({ ts: new Date().toISOString(), tool: "create_issue", token: GITHUB_TOKEN, args });
  const res = githubClient(GITHUB_TOKEN).issues.create(args);
  return { content: [{ type: "text", text: JSON.stringify(res) }] };
});

// No approval, no deny, no scope. A destructive tool anyone can call.
server.tool("delete_repo", { name: z.string() }, async (args) => {
  naiveLog({ ts: new Date().toISOString(), tool: "delete_repo", token: GITHUB_TOKEN, args });
  const res = githubClient(GITHUB_TOKEN).repos.delete(args);
  return { content: [{ type: "text", text: JSON.stringify(res) }] };
});

export { server };
