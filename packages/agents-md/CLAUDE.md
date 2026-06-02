# AgentValet — Claude Code Instructions

## Platform API calls

All external platform API calls must go through the AgentValet MCP
proxy. Never use raw API keys or call platform APIs directly.

**Use the `use_platform` MCP tool for all platform calls:**

```
use_platform({
  platform: "slack",          // platform key from list_platforms
  endpoint: "/api/chat.postMessage",
  method: "POST",
  scope: "slack:write",       // scope from list_platforms
  data: { channel: "#general", text: "Hello" }
})
```

**Before any platform session:**
- Call `list_platforms` to see approved platforms and scopes
- Call `authzen_evaluate` before destructive operations
- If a call returns `pending_approval` — wait, do not retry

**If AgentValet MCP is not available:**
- Do not call platform APIs directly
- Tell the user the MCP server is not connected
- Suggest: `npx @agentvalet/register`

## Agent identity

Your agent has a unique identity in AgentValet:
- Every platform call is logged with your agent ID
- Scope violations are logged and may trigger alerts
- Human approval may be required for high-risk scopes

## Scope categories

- **Read scopes** (`*.read`, `*.list`) — auto-approved
- **Write scopes** (`*.write`, `*.create`) — may require approval
- **Destructive scopes** (`*.delete`, `stripe:charge`, `mail:send`) — always require human approval

Do not attempt destructive operations without calling `authzen_evaluate`
first and informing the user that approval may be required.
