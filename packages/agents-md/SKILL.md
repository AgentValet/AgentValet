# AgentValet Skill

## What this skill does

Routes all platform API calls through AgentValet's credential proxy.
Your raw API keys and OAuth tokens are never exposed to this agent —
AgentValet injects the correct credential per platform call.

## Setup

1. Run `npx @agentvalet/register` in your terminal
2. Follow the prompts to authenticate with GitHub
3. Approve your agent in the AgentValet dashboard
4. Connect the platforms you want this agent to access

## Making platform calls

Instead of calling platform APIs directly, describe what you want to
do and the agent will use the `use_platform` tool:

**Example:**
> "Post a message to the #general Slack channel saying the daily
> report is ready"

The agent will call:
```
use_platform({
  platform: "slack",
  endpoint: "/api/chat.postMessage",
  method: "POST",
  scope: "slack:write",
  data: { channel: "#general", text: "Daily report is ready" }
})
```

## Rules this agent follows

1. Never calls platform APIs directly — always uses AgentValet proxy
2. Checks `list_platforms` before assuming a platform is available
3. Checks `authzen_evaluate` before destructive operations
4. Waits for human approval when required — does not retry aggressively

## Available platforms

Your available platforms depend on what you've connected in the
AgentValet dashboard. Run `list_platforms` to see the current list.

## Security

- Every call is logged with your agent's identity
- You can revoke this agent's access instantly at app.agentvalet.ai
- Approval-required actions are held until you respond
