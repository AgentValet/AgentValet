# @agentvalet/client

Call approved SaaS platforms from any Node agent. Your agent never holds the
downstream credential — AgentValet signs a short-lived identity assertion,
checks the call against the owner's grants and policy, injects the credential
at call time, and writes an audit record.

**Not in an MCP host?** This is your package. If you *are* inside Claude Code,
Claude Desktop, Cursor, or another MCP-aware host, install
[`@agentvalet/mcp-server`](https://www.npmjs.com/package/@agentvalet/mcp-server)
instead and call `use_platform` — you get the same guarantees with no code.

Building your own MCP *server* and want to enforce policy inside it? That's
[`@agentvalet/mcp-broker`](https://www.npmjs.com/package/@agentvalet/mcp-broker).

## Install

```bash
npm install @agentvalet/client
```

Node 18+. One dependency (`jose`, for RS256 signing).

## Get an agent identity

```bash
npx @agentvalet/register
```

This generates an RSA keypair **locally** — the private key never leaves your
machine — registers the public half, and writes `~/.agentvalet/agent.key`.

## Use it

```typescript
import { AgentValet } from "@agentvalet/client";

const av = AgentValet.fromEnv();

const result = await av.call({
  platform: "slack",
  endpoint: "/api/chat.postMessage",
  method: "POST",
  scope: "chat:write",
  data: { channel: "#general", text: "Deploy finished." },
});
```

`fromEnv()` reads `AGENTVALET_AGENT_ID` / `AGENTVALET_OWNER_ID` (or the bare
`AGENT_ID` / `OWNER_ID` the CLI writes) and finds the key via
`AGENT_PRIVATE_KEY_B64`, `AGENT_PRIVATE_KEY_PATH`, `AGENT_PRIVATE_KEY`, or
`~/.agentvalet/agent.key`. To wire it up explicitly:

```typescript
const av = new AgentValet({
  agentId: process.env.AGENT_ID!,
  ownerId: process.env.OWNER_ID!,
  privateKey: process.env.AGENT_PRIVATE_KEY!,
  proxyUrl: "https://api.agentvalet.ai",   // default
});
```

## Approvals are just a slower call

When the owner has marked a scope as requiring approval, the proxy holds the
action and `call()` waits. If the owner approves, the proxy re-runs the call and
you get the result back — from your code's point of view it simply took longer.

```typescript
const av = AgentValet.fromEnv({
  onApprovalPending: ({ elapsedMs }) =>
    console.log(`waiting for owner… ${Math.round(elapsedMs / 1000)}s`),
});
```

If nobody responds inside the budget (50s by default), you get an
`ApprovalTimeoutError` — **not** a failure. The action stays queued. Keep the
`approvalId` and resume whenever you like:

```typescript
import { ApprovalTimeoutError } from "@agentvalet/client";

try {
  await av.call({ platform: "stripe", endpoint: "/v1/refunds", method: "POST", scope: "charge" });
} catch (err) {
  if (err instanceof ApprovalTimeoutError) {
    await saveForLater(err.approvalId);          // e.g. into your job queue
  }
}

// …later, in another process:
const result = await av.waitForApproval(approvalId);
```

Set `approvalTimeoutMs: 0` if you never want to block — `call()` then throws
`ApprovalTimeoutError` the moment approval is required.

## Errors you can branch on

Every throw is typed, so you never string-match an error envelope:

| Error | Means | What to do |
|---|---|---|
| `ConfigError` | Bad/missing identity or key | Fix config; thrown before any network call |
| `NetworkError` | Transport failed | `.message` diagnoses DNS / TLS / firewall / timeout |
| `AccessDeniedError` | No grant, or policy blocked it | `requestAccess()` — see below |
| `ApprovalDeniedError` | Owner said no | Terminal. Don't retry |
| `ApprovalExpiredError` | Aged out server-side | Re-issue the call |
| `ApprovalTimeoutError` | You stopped waiting | Resume via `waitForApproval(approvalId)` |
| `UpstreamError` | The SaaS itself returned non-2xx | `.status` / `.data` hold the upstream reply |
| `ProxyError` | Anything else from the broker | `.status` / `.body` |

## Asking for access you don't have

Deny-by-default means a scope you were never granted returns
`AccessDeniedError`. Your agent can ask for it:

```typescript
const { status } = await av.requestAccess({
  platform: "slack",
  scope: "chat:write",
  reason: "Post deploy notifications to #general",
});
if (status === "approved") { /* retry the original call */ }
```

## Checking before you act

```typescript
await av.listPlatforms();                  // what this agent is actually granted
await av.pendingActions();                 // queued behind an approval
await av.evaluate("stripe", "charge");     // dry-run the decision, no side effect
```

`evaluate()` is worth a call before anything destructive — it tells you whether
the action would be allowed without performing it.

## Self-hosting

Point `proxyUrl` at your own deployment. Everything else is identical.

## License

MIT
