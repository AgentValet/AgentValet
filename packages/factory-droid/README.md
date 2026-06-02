# @agentvalet/factory-droid

AgentValet governance droid for Factory Droid.

## Install

```bash
npm install @agentvalet/factory-droid
```

Files are copied to `.factory/droids/` and `.factory/commands/`
automatically on install. Commit them to your repo.

## What's installed

| File | Purpose |
|------|---------|
| `.factory/droids/agentvalet.yaml` | AgentValet governance droid |
| `.factory/commands/av-status.md` | `/av-status` slash command |
| `.factory/commands/av-register.md` | `/av-register` slash command |

## Setup

1. Run `npx @agentvalet/register` to create your account
2. Approve your agent at app.agentvalet.ai/agents
3. Configure platform permissions for this agent
4. Use `/av-status` in Factory Droid to verify

## The AgentValet droid

Activate it in Factory Droid by typing `@AgentValet` in the chat.
It will route all platform API calls through AgentValet's governance
proxy — credential injection, scope enforcement, approval queuing,
and full audit logging.
