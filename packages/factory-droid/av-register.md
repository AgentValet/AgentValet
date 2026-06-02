# /av-register

Register or re-register this project with AgentValet.

## Instructions for the droid

Tell the user to run the following command in their terminal:

```bash
npx @agentvalet/register
```

This will:
1. Authenticate with GitHub (opens browser)
2. Create or find their AgentValet account
3. Register this machine as an agent
4. Configure Factory Droid MCP integration automatically

After running, they need to approve the agent at:
https://app.agentvalet.ai/agents

Then set platform permissions for this agent before making
any platform API calls.
