# AgentValet (open core)

Cryptographic identity, scoped permissions, and a governed credential proxy for AI agents.

This repository is the **open-core** client surface of AgentValet — the agent-facing
packages that are MIT-licensed and safe to self-host or extend. The hosted control
plane (proxy, dashboard, infrastructure) is operated at https://agentvalet.ai.

## Packages

| Package | What it is |
|---|---|
| `@agentvalet/register` (`packages/cli`) | One-command agent registration CLI |
| `@agentvalet/mcp-server` (`packages/mcp-server`) | MCP server that routes agent platform calls through AgentValet |
| `@agentvalet/mcpb` (`packages/mcpb`) | One-click MCP bundle for Claude Desktop |
| `@agentvalet/paperclip-adapter` | Paperclip integration |
| `@agentvalet/factory-droid` | Factory Droid governance droid |
| `agentvalet-vscode` | VS Code extension |
| `@agentvalet/agents-md` | AGENTS.md / CLAUDE.md / SKILL.md templates |

## Quick start

```bash
npx @agentvalet/register
```

## Develop

```bash
pnpm install
pnpm -r build
```

## Links

- Website: https://agentvalet.ai
- Docs: https://docs.agentvalet.ai

## License

MIT — see [LICENSE](./LICENSE).
