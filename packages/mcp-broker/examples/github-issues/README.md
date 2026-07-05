# Insecure, then fixed: a GitHub-issues MCP server

This is the same small MCP server twice. The first version is how a lot of tool
servers actually get written. The second adds three lines of
`@agentvalet/mcp-broker` and fixes all of it. The two audit logs under
`fixtures/` are the before and after, side by side.

## Before (`insecure-server.ts`)

- A raw personal access token lives in the handler's closure.
- No policy check, so `delete_repo` executes for anyone who can reach the server.
- The only record is an ad-hoc log line that writes the token and the full
  arguments to disk.

`fixtures/audit-before.jsonl`:

```json
{"ts":"…","tool":"create_issue","token":"ghp_EXAMPLE…","args":{"title":"Prod is down","body":"Customer X reports 500s since 08:50"}}
{"ts":"…","tool":"delete_repo","token":"ghp_EXAMPLE…","args":{"name":"acme/really-important-repo"}}
```

The token is in the log. The issue body is in the log. The repo deletion just
happened, with no approval and no way to have said no.

## After (`secure-server.ts`)

The diff is three lines: import `broker`, call `broker(server, { … })` once
before registering tools, and read `ctx.credential.token` in the handler instead
of a module-level secret.

`fixtures/audit-after.jsonl` (from a real client round trip through the broker):

```json
{"…":"…","resource":{"server":"github-tools","tool":"create_issue"},"argsFingerprint":"sha256:3431…","decision":{"effect":"allow",…},"outcome":"allowed","warnings":["credential_no_expiry_static_secret"]}
{"…":"…","resource":{"server":"github-tools","tool":"export_secrets"},"argsFingerprint":"sha256:ad91…","decision":{"effect":"deny",…},"outcome":"denied"}
{"…":"…","resource":{"server":"github-tools","tool":"delete_repo"},"argsFingerprint":"sha256:2ca1…","decision":{"effect":"require_approval",…},"outcome":"approval_timeout","warnings":["approval_timeout"]}
```

What changed:

- No token anywhere in the log. The handler gets a resolved credential at call
  time; it never holds a long-lived secret.
- No raw arguments in the log, only a `sha256` fingerprint you can correlate on
  without seeing the payload.
- `create_issue` is allowed by policy. The `credential_no_expiry_static_secret`
  warning is the broker telling you a local `env:` secret is static, which is
  the nudge toward the hosted vault.
- `export_secrets` is not in the policy, so it is denied by default. Nothing ran.
- `delete_repo` needs a human. With no approval it times out and is denied,
  audited as `approval_timeout`. The repo is still there.

## Regenerating the fixtures

```bash
pnpm build
GITHUB_ISSUES_RW=… GITHUB_ADMIN=… node examples/github-issues/generate-fixtures.mjs
```

The `after` log is genuine broker output; only the timestamp and latency fields
are normalized so the committed file is stable to diff. The example token is a
fake, and the `-----`-free `ghp_EXAMPLE…` shape exists only to show what the
broker keeps out of your logs.
