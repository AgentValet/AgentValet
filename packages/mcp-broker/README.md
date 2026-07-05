# @agentvalet/mcp-broker

An embeddable credential broker and policy enforcement wrapper for MCP servers.
Wrap your server once. Every tool you register after that is policy-checked,
gets a resolved narrow credential injected at call time, and emits an audit
record. The agent never holds the downstream secret.

It's free and open source. The paid layer is the hosted AgentValet control
plane (managed policy, push approvals, SSO, central audit, the vault), and it
plugs in through the same four interfaces this package defines.

This is the mirror image of `@agentvalet/mcp-server`: that package lets an agent
call platforms through the AgentValet proxy, whereas this package lets you embed
AgentValet enforcement inside your own MCP server.

## Install

```bash
npm install @agentvalet/mcp-broker
```

`@modelcontextprotocol/sdk` is a peer dependency you already have. The broker
itself has zero runtime dependencies.

## Three lines to adopt

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { broker } from "@agentvalet/mcp-broker";

const server = new McpServer({ name: "github-tools", version: "1.0.0" });

// Wrap once. Every tool registered after this is policy-checked,
// credential-injected, and audited.
broker(server, {
  policy: "file:./policy.yaml",          // or "authzen:https://pdp.example.com"
                                          // or "agentvalet:" (hosted)
  secrets: "env:",                        // or "file:./secrets.enc"
  audit: "jsonl:./audit.log",             // or "agentvalet:" (hosted)
});

server.tool("create_issue", schema, async (args, ctx) => {
  // ctx.credential is the resolved, narrow secret for this call only.
  return await githubClient(ctx.credential.token).issues.create(args);
});
```

You don't restructure your handlers. `broker()` intercepts tool registration, so
register your tools after the wrap and each one runs inside the enforcement
pipeline:

```
resolve identity -> evaluate policy -> (approval if required) ->
resolve credential -> invoke handler -> redact -> audit
```

## Fail closed by default

`failMode` defaults to `"closed"`. If the policy source is unreachable, the call
is denied. `"open"` exists for a dev loop only, and it logs loudly on every
request. A security tool that fails open is not a security tool.

## The same policy semantics as the hosted plane, provably

The `file:` policy source evaluates your local YAML with a byte-identical copy of
the exact policy kernel the hosted AgentValet plane runs. The copy is generated
by a sync script and a contract test fails the build if it ever drifts. So a
rule you write locally decides allow, deny, or require_approval with the same
semantics you'd get in the cloud. There's no second implementation to disagree
with.

## Local policy is small on purpose

```yaml
version: 1
defaults:
  effect: deny
rules:
  - tool: create_issue
    effect: allow
    credential: github_issues_rw
  - tool: delete_repo
    effect: require_approval
    credential: github_admin
```

One file, one rule per tool, deny by default. There are no environments, no
inheritance, no templating, and no record of who changed a rule. That's a
deliberate limit, not a missing feature. The moment you need any of those, you've
outgrown a single file, and that's what the hosted plane is for. This format
will never grow them.

## The four interfaces

Every escape hatch is an interface, and the hosted implementations are just the
best implementation of each:

- `PolicySource` decides allow, deny, or require_approval for a call.
- `SecretSource` resolves a narrow credential and honours scope narrowing from
  the decision's obligations.
- `ApprovalProvider` gates a call on a human decision. The reference
  implementation is a CLI y/n prompt with a timeout; the hosted one is push
  approval to the owner's devices.
- `AuditSink` receives a stable, versioned event carrying an args fingerprint,
  never the raw arguments.

Pass a scheme string (`"file:"`, `"env:"`, `"jsonl:"`, `"authzen:"`,
`"agentvalet:"`) or your own implementation object. Both work everywhere.

## What the audit records

Each tool call emits one event: caller identity, server and tool, an args
fingerprint (never the raw args), the decision and policy version, the credential
scope, latency, and the outcome. Every outcome is covered, including denials,
approval timeouts, and handler errors.

## License

MIT.
