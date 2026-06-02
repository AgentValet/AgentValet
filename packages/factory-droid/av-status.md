# /av-status

Check your AgentValet agent status and approved platform connections.

## Instructions for the droid

1. Call `list_platforms` using the AgentValet MCP server
2. Display the results in a clean table:
   - Platform name
   - Approved scopes
   - Whether any scope requires human approval
3. If no platforms are approved yet, tell the user to visit
   https://app.agentvalet.ai/agents to configure permissions
4. If AgentValet MCP is not connected, explain how to set it up:
   Run: npx @agentvalet/register

## Example output

```
AgentValet — approved platforms for this agent

Platform        Scopes                    Approval required
─────────────   ───────────────────────   ─────────────────
Slack           slack:read, slack:write   mail:send → Yes
GitHub          github:read               —
Stripe          stripe:read               stripe:charge → Yes

Agent ID: agt_abc123
Dashboard: https://app.agentvalet.ai
```
