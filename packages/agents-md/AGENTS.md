# AgentValet — Credential Governance

This project uses AgentValet to govern all platform API calls made
by AI agents. Every call to an external SaaS platform must go through
the AgentValet proxy — never call platform APIs directly.

## Why

AgentValet:
- Injects the correct credential per platform (you never see raw API keys)
- Enforces which platforms and scopes this agent is allowed to use
- Logs every call for audit and compliance
- Holds calls that require human approval before proceeding

## How to make a platform API call

**Do NOT call platform APIs directly:**
```
❌  POST https://api.slack.com/api/chat.postMessage
    Authorization: Bearer xoxb-real-token-here
```

**Use the `use_platform` MCP tool instead:**
```
✓   use_platform({
      platform: "slack",
      endpoint: "/api/chat.postMessage",
      method: "POST",
      scope: "slack:write",
      data: { channel: "#general", text: "Hello" }
    })
```

The proxy validates your identity, checks your permissions, and
forwards the call with the real credential injected automatically.

## Before making any platform call

1. Call `list_platforms` to see which platforms are approved for
   this agent and what scopes are available.

2. Only call platforms and scopes that appear in `list_platforms`.
   Attempting an unapproved scope returns a 403 and is logged.

3. If a call returns `{ "status": "pending_approval" }`, the action
   requires human approval. Poll `agent_status` or wait — do not
   retry the call repeatedly.

## Checking permissions

Use `authzen_evaluate` to check whether a specific action is permitted
before attempting it:

```
authzen_evaluate({
  platform_id: "stripe",
  scope: "stripe:charge"
})
// Returns: { decision: true/false, reason: "..." }
```

Always check before attempting destructive or high-risk operations.

## Platforms and scopes

Call `list_platforms` at the start of any session that involves
platform API calls. It returns the current approved platform list
for this agent — do not assume platforms are available without checking.

## If the MCP server is not connected

If AgentValet MCP tools are not available in your current session:
1. Do not attempt to call platform APIs directly
2. Tell the user: "AgentValet MCP server is not connected. Platform
   calls are disabled for safety. Run: npx @agentvalet/register"
3. Do not proceed with tasks that require platform access

## Setup (for developers adding this to a project)

1. Install and register: `npx @agentvalet/register`
2. Add to your MCP config (auto-configured by the register command)
3. Add this file to your project root as `AGENTS.md`

Documentation: https://docs.agentvalet.ai
