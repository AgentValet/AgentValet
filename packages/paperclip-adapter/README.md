# @agentvalet/paperclip-adapter

Paperclip adapter for AgentValet — credential proxy and identity governance for Paperclip agents.

## What it does

AgentValet sits between Paperclip agents and SaaS platforms (Slack, Stripe, Gmail, Airtable, etc.). When a Paperclip agent is configured with this adapter, every platform API call is routed through AgentValet, which validates the agent's identity, enforces scope permissions, applies rate limits, triggers human-in-the-loop approvals where required, and writes a full audit trail.

## Architecture

```
Paperclip                    AgentValet              SaaS Platforms
┌──────────────┐             ┌─────────────┐         ┌───────────┐
│  Heartbeat   │──execute()─▶│  Identity   │         │           │
│  Scheduler   │             │  check      │         │  Slack    │
│              │             │             │─────────▶│  Stripe   │
│  Issue Queue │             │  Scope gate │         │  Gmail    │
│              │◀──results───│             │◀─────────│  Airtable │
│  Audit UI    │             │  Audit log  │         └───────────┘
└──────────────┘             └─────────────┘
         │                          │
         │                   ┌──────┴──────┐
         │                   │  Dashboard  │
         └───────────────────│  (approve / │
                             │   revoke)   │
                             └─────────────┘
```

## Two-layer model

Authentication (who am I?) is company-level — one RS256 key shared across all agents. Authorisation (what can I do?) is agent-level — configured per-agent in the AgentValet dashboard.

## Prerequisites

- Node.js 20+
- A Paperclip instance with an adapter registry
- An AgentValet account at https://app.agentvalet.ai
- An RS256 keypair (one per Paperclip company)

## Installation into Paperclip

```bash
npm install @agentvalet/paperclip-adapter
```

Register it in your Paperclip instance by adding to three registry files:

### server/src/adapters/registry.ts

```typescript
import * as agentValet from "@agentvalet/paperclip-adapter";
import { execute, testEnvironment } from "@agentvalet/paperclip-adapter/server";

registry.set("agentvalet", { ...agentValet, execute, testEnvironment });
```

### ui/src/adapters/registry.ts

```typescript
import * as agentValet from "@agentvalet/paperclip-adapter";
import { parseStdout, buildConfig } from "@agentvalet/paperclip-adapter/ui";

registry.set("agentvalet", { ...agentValet, parseStdout, buildConfig });
```

### cli/src/adapters/registry.ts

```typescript
import * as agentValet from "@agentvalet/paperclip-adapter";
import { formatEvent } from "@agentvalet/paperclip-adapter/cli";

registry.set("agentvalet", { ...agentValet, formatEvent });
```

Then rebuild your Paperclip instance.

## Company-level setup (required once)

Set these environment variables in your Paperclip server:

```
AGENTVALET_PROXY_URL=https://api.agentvalet.ai
AGENTVALET_OWNER_ID=<your owner ID from AgentValet Settings>
AGENTVALET_COMPANY_KEY=<RS256 private key PEM — never commit this>
```

## Setting up your company key

`AGENTVALET_COMPANY_KEY` is an RSA-2048 private key used to sign
JWT tokens that identify your Paperclip company to AgentValet.
AgentValet verifies the signature using the corresponding public key,
which you register once in the dashboard.

### Option 1 — Let AgentValet generate it (recommended)

1. Open AgentValet → Settings → Integrations → Paperclip
2. Click **Generate keypair**
3. Copy the private key from the modal — it's shown once only
4. Set it as `AGENTVALET_COMPANY_KEY` in your Paperclip instance
5. Done — the public key is stored automatically

### Option 2 — Generate your own with openssl

```bash
# Generate private key
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
  -out agentvalet-company.key

# Extract public key (paste this into AgentValet)
openssl rsa -in agentvalet-company.key -pubout \
  -out agentvalet-company.pub
```

Then in AgentValet → Settings → Integrations → Paperclip,
paste the contents of `agentvalet-company.pub` using
"Register your own key".

Set `AGENTVALET_COMPANY_KEY` to the full contents of
`agentvalet-company.key`.

### Option 3 — Generate with Node.js

```javascript
const { generateKeyPairSync } = require('crypto');

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

console.log('Set as AGENTVALET_COMPANY_KEY:\n', privateKey);
console.log('Paste into AgentValet:\n', publicKey);
```

### Multi-line env var handling

If your environment mangles newlines in env vars:

| Format | Example | Notes |
|--------|---------|-------|
| Multi-line (ideal) | Normal PEM with real newlines | Works natively |
| Escaped | `-----BEGIN...\\nMIIE...\\n-----END...` | Adapter converts automatically |
| Base64 | Set `AGENTVALET_COMPANY_KEY_B64` | Adapter detects and decodes |

### One key per Paperclip company

Use a separate keypair for each Paperclip company (e.g. production
vs staging). Label them clearly in AgentValet. To rotate a key,
generate a new one in AgentValet, update the env var, and revoke
the old key in the dashboard.

## Quick start — agent config

Create an agent with this `adapterConfig`:

```json
{
  "adapterType": "agentvalet",
  "adapterConfig": {
    "underlyingAdapter": "claude_local",
    "underlyingAdapterConfig": { "cwd": "/projects/my-agent" },
    "agentvaletScopes": ["slack:read", "slack:write"],
    "approvalTimeoutSec": 60
  }
}
```

## Configuration reference

| Field | Type | Default | Description |
|---|---|---|---|
| `underlyingAdapter` | string | `"claude_local"` | Paperclip adapter to delegate execution to |
| `underlyingAdapterConfig` | object | `{}` | Config passed verbatim to the underlying adapter |
| `agentvaletScopes` | string[] | `[]` | Hint only — scopes this agent intends to use |
| `approvalTimeoutSec` | number | `60` | Seconds to wait for human approval |
| `tokenTtlSec` | number | `300` | JWT lifetime per run (seconds) |
| `registrationTimeoutSec` | number | `120` | Seconds to wait for owner to approve new agent |

## How approval blocking works

When an agent calls a platform with a scope requiring approval, AgentValet returns `{ "status": "pending_approval", "approval_id": "apr_..." }`. The agent should poll `GET /v1/approvals/{approval_id}` every 5 seconds. If not approved within `approvalTimeoutSec`, the adapter returns a blocked result to Paperclip, which retries on the next heartbeat.

## Security notes

- The RS256 private key (`AGENTVALET_COMPANY_KEY`) must be set as an environment variable — never in `adapterConfig`
- JWTs are minted fresh per heartbeat run and expire after `tokenTtlSec` seconds
- `AGENTVALET_AGENT_TOKEN` is never logged or printed — the CLI formatter redacts it
- One keypair per Paperclip company — never reuse keys across companies
- `agentvaletScopes` in adapterConfig is a hint only — it never self-grants permissions
