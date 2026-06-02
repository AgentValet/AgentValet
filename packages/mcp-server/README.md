# @agentvalet/mcp-server

MCP server that lets AI agents (Claude Code, Cursor, Codex CLI, etc.) call approved external platforms through the AgentValet proxy.

## Quick start

```bash
npx @agentvalet/register   # registers this machine as an agent, writes config
```

The CLI writes env vars and optionally updates `.mcp.json` or `.cursor/mcp.json` automatically.

## Manual configuration

Add to your `.mcp.json` or equivalent:

```json
{
  "mcpServers": {
    "agentvalet": {
      "command": "npx",
      "args": ["-y", "@agentvalet/mcp-server"],
      "env": {
        "AGENT_ID": "agt_...",
        "OWNER_ID": "...",
        "PROXY_URL": "https://api.agentvalet.ai",
        "AGENT_PRIVATE_KEY_PATH": "/path/to/agent.key"
      }
    }
  }
}
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AGENT_ID` | Yes | Agent ID from registration |
| `OWNER_ID` | Yes | Owner ID from registration |
| `PROXY_URL` | Yes | AgentValet proxy URL |
| `AGENT_PRIVATE_KEY_PATH` | One of three | Path to PEM private key file |
| `AGENT_PRIVATE_KEY` | One of three | Raw PEM or `\n`-escaped single-line PEM |
| `AGENT_PRIVATE_KEY_B64` | One of three | Base64-encoded PEM |
| `MCP_TRANSPORT` | No | Set to `http` to use HTTP transport instead of STDIO |
| `MCP_PORT` | No | Port for HTTP transport (default: `3100`) |

## Tools

| Tool | Auth | Description |
|------|------|-------------|
| `list_platforms` | JWT | List platforms and scopes this agent has access to |
| `use_platform` | JWT | Call an external platform API through the proxy |
| `agent_register` | None | Self-register a new agent with an owner |
| `agent_status` | None | Poll registration approval status |
| `authzen_evaluate` | None | Check if this agent has access to a platform scope |

## Transports

**STDIO (default)** — compatible with all MCP hosts (Claude Code, Cursor, Codex CLI).

**HTTP** — set `MCP_TRANSPORT=http` and optionally `MCP_PORT=3100`. Uses `StreamableHTTPServerTransport`.

## Architecture

Each tool call signs a short-lived RS256 JWT (`exp: 60s`) using the agent's private key. The JWT is verified by the AgentValet proxy, which checks permissions and forwards the request to the target platform using stored credentials.

The agent never sees platform credentials. The proxy decrypts them in-memory at call time and discards them after the upstream request completes.
