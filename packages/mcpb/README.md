# @agentvalet/mcpb

MCPB bundle for AgentValet. Drag-and-drop install into Claude Desktop.

## What this is

A `.mcpb` bundle that ships the AgentValet MCP server as a one-click install for Claude Desktop. Wraps the same `@agentvalet/mcp-server` published to npm — no behaviour change.

## What's in the bundle

- `manifest.json` — MCPB v0.3 manifest
- `server/` — compiled `@agentvalet/mcp-server` plus its two production deps (`@modelcontextprotocol/sdk`, `jose`)
- `icon.png` — 512x512 PNG (add before first release)

## What's NOT in the bundle

- Platform credentials. Those stay in the AgentValet vault (Azure Key Vault HSM, KEK/DEK envelope encryption).
- The KEK. Lives in Azure HSM. The bundle never touches it.
- Nango OAuth tokens. Self-hosted Nango stays remote.
- Audit log. Stored in Supabase, never local.

The bundle stores only the agent's RS256 private key, in the OS keychain via Claude Desktop's `user_config.sensitive` mechanism.

## Build

```sh
pnpm install
pnpm --filter @agentvalet/mcpb build
pnpm --filter @agentvalet/mcpb pack
```

Output: `apps/mcpb/agentvalet.mcpb`.

Validate before shipping:

```sh
pnpm --filter @agentvalet/mcpb validate
pnpm --filter @agentvalet/mcpb info
```

## Install (sideload)

1. Download `agentvalet.mcpb` from agentvalet.ai/install (or build locally).
2. Open Claude Desktop → Settings → Extensions.
3. Drag the `.mcpb` file onto the window.
4. Fill the `user_config` fields:
   - `Proxy URL` — defaults to `https://api.agentvalet.ai`
   - `Agent ID`, `Owner ID`, `Agent Private Key (base64)` — leave blank on first install, then run the `agent_register` tool inside Claude to provision

## First-run flow

If no agent ID / key is configured, the MCP tools (`list_platforms`, `use_platform`) return a pending-activation message. Run the `agent_register` tool in Claude with your owner ID and requested scopes. The owner approves in the dashboard. The tool returns `mcp_config` values — paste them back into the extension settings.

## Release

See `docs/runbooks/mcpb-release.md`.

## Signing

Day 1: unsigned. Sign before public launch:

```sh
npx @anthropic-ai/mcpb sign agentvalet.mcpb --cert <path> --key <path>
npx @anthropic-ai/mcpb verify agentvalet.mcpb
```
