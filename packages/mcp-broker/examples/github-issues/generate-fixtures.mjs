// Regenerates the two committed audit logs under fixtures/.
//
//   node examples/github-issues/generate-fixtures.mjs   (after `pnpm build`)
//
// audit-after.jsonl is produced by driving the fixed server through a real MCP
// client round trip, so it is genuine broker output. audit-before.jsonl is the
// naive server's ad-hoc log, written here to mirror exactly what
// insecure-server.ts's naiveLog would append. Timestamps and latency are
// normalized to fixed values so the committed fixtures are stable to read and to
// diff; every other field is the real thing.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { broker, FilePolicySource, EnvSecretSource, MemoryAuditSink } from "../../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");
mkdirSync(fixtures, { recursive: true });

const RAW_PAT = "ghp_EXAMPLEonlyNotARealToken0123456789ab";

// ── BEFORE: the naive server's log. Token and raw args, every call, no gate. ──
const before = [
  { ts: "2026-07-05T09:00:00.000Z", tool: "create_issue", token: RAW_PAT, args: { title: "Prod is down", body: "Customer X reports 500s since 08:50" } },
  { ts: "2026-07-05T09:01:00.000Z", tool: "delete_repo", token: RAW_PAT, args: { name: "acme/really-important-repo" } },
];
writeFileSync(join(fixtures, "audit-before.jsonl"), before.map((e) => JSON.stringify(e)).join("\n") + "\n");

// ── AFTER: real broker audit from a client round trip. ──
const audit = new MemoryAuditSink();
const server = new McpServer({ name: "github-tools", version: "1.0.0" });
broker(server, {
  policy: new FilePolicySource(join(here, "policy.yaml")),
  secrets: new EnvSecretSource("", { GITHUB_ISSUES_RW: RAW_PAT, GITHUB_ADMIN: RAW_PAT }),
  audit,
  // A provider that never approves, so delete_repo shows the human gate as a
  // timeout denial rather than silently executing.
  approval: { request: async () => ({ approved: false, reason: "timeout" }) },
});

server.tool("create_issue", { title: z.string(), body: z.string() }, async (a, ctx) => ({
  content: [{ type: "text", text: JSON.stringify({ ok: true, sentWith: ctx.credential.token.slice(0, 4) + "…" }) }],
}));
server.tool("delete_repo", { name: z.string() }, async () => ({ content: [{ type: "text", text: "deleted" }] }));
// A tool that is not in the policy at all: denied by default.
server.tool("export_secrets", { scope: z.string() }, async () => ({ content: [{ type: "text", text: "dumped" }] }));

const [ct, st] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "demo", version: "1.0.0" });
await Promise.all([server.connect(st), client.connect(ct)]);

await client.callTool({ name: "create_issue", arguments: { title: "Prod is down", body: "Customer X reports 500s since 08:50" } });
await client.callTool({ name: "export_secrets", arguments: { scope: "all" } });
await client.callTool({ name: "delete_repo", arguments: { name: "acme/really-important-repo" } });
await client.close();

// Normalize the two nondeterministic fields so the committed fixture is stable.
const after = audit.events.map((e, i) => ({
  ...e,
  ts: `2026-07-05T09:1${i}:00.000Z`,
  latencyMs: 3,
}));
writeFileSync(join(fixtures, "audit-after.jsonl"), after.map((e) => JSON.stringify(e)).join("\n") + "\n");

console.log(`wrote ${before.length} before rows and ${after.length} after rows to ${fixtures}`);
