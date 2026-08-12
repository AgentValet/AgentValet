# Examples — `@agentvalet/client` (TypeScript)

Runnable use cases for the Node SDK. Each is standalone.

```bash
npm install @agentvalet/client
npx @agentvalet/register
npx tsx 01-quickstart.ts
```

`register` generates an RSA keypair **on your machine** — only the public half
is sent — and writes `~/.agentvalet/agent.key`. After that `AgentValet.fromEnv()`
works with no arguments.

**In an MCP host?** If you're in Claude Code, Claude Desktop, or Cursor, you
don't need this package — install
[`@agentvalet/mcp-server`](https://www.npmjs.com/package/@agentvalet/mcp-server)
and call `use_platform`. This SDK is for agents that aren't MCP: LangChain
tools, cron jobs, CI, plain services.

| File | Use case |
|---|---|
| [`01-quickstart.ts`](./01-quickstart.ts) | One governed call, and what to do when you lack the grant |
| [`02-approvals.ts`](./02-approvals.ts) | Approval-gated actions: blocking, non-blocking, and resuming later |
| [`03-deploy-bot.ts`](./03-deploy-bot.ts) | Unattended CI job that never stalls waiting on a human |

Python equivalents live in
[`packages/python-client/examples`](../../python-client/examples).

## The one thing to get right

`ApprovalTimeoutError` **is not a failure.** It means you stopped waiting — the
action is still queued and will run if the owner approves. Catch it, keep the
`approvalId`, and resume with `waitForApproval()` later, from any process:

```typescript
try {
  await av.call({ platform: "stripe", endpoint: "/v1/refunds",
                  method: "POST", scope: "charge", data: {...} });
} catch (err) {
  if (err instanceof ApprovalTimeoutError) {
    await queue.add(err.approvalId);   // not an error path — a continuation
  }
}
```

Treating it as an error is the most common mistake. The action completes later
regardless; you just stop being the one who hears about it.

## Errors worth branching on

| Error | Means | Do |
|---|---|---|
| `AccessDeniedError` | No grant, or policy blocked it | `requestAccess()`, or report back |
| `ApprovalDeniedError` | The owner said no | Stop. Don't retry or route around it |
| `ApprovalExpiredError` | Aged out unanswered | Re-issue if still needed |
| `ApprovalTimeoutError` | You stopped waiting | Resume via `waitForApproval()` |
| `UpstreamError` | The SaaS itself rejected it | `.status` / `.data` hold its reply |
| `ConfigError` | Bad identity or key | Fix config — thrown before any network call |

## Running in CI or a container

There's no `~/.agentvalet` on a fresh runner, so supply identity by env:

```
AGENT_ID=agt_...
OWNER_ID=...
AGENT_PRIVATE_KEY_B64=<base64 of the PEM>     # survives env-var mangling
```

`AGENT_PRIVATE_KEY` (raw or `\n`-escaped PEM) and `AGENT_PRIVATE_KEY_PATH` also
work. Store the key in your CI secret store — it is the agent's identity, and
anything holding it can act as that agent.

## Note on the examples

They use real endpoints so you can run them against your own connected
platforms. They will throw `AccessDeniedError` until the corresponding scope is
granted — which is the system working, not a bug. Start with
`av.listPlatforms()` to see what your agent actually has.
