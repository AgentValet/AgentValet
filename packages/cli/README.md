# @agentvalet/register

Register your AI agent with AgentValet in 30 seconds.

## Usage

```bash
npx @agentvalet/register
```

No installation required. Authenticate with GitHub, and your agent is registered automatically.

## What it does

1. Opens your browser to authenticate with GitHub
2. Creates your AgentValet account (or finds your existing one)
3. Registers this machine as an agent
4. Writes config to `.agentvalet/` in the current directory
5. Outputs the environment variables you need

## Requirements

- Node.js 18+
- A GitHub account
- An internet connection

## After registration

Approve your agent in the AgentValet dashboard to activate it:
https://app.agentvalet.ai/agents

## Commands

```bash
npx @agentvalet/register          # Register a new agent (GitHub onboarding)
npx @agentvalet/register refresh  # Refresh approved permissions
```

## What gets written

- `.agentvalet/config.json` — agent ID, proxy URL, registration timestamp
- `.agentvalet/agent.key` — private key (mode 0600, never shared)

`.agentvalet/` is automatically added to your `.gitignore`.

## Advanced: existing owner ID

If you already have an AgentValet owner ID, pass it directly:

```bash
AGENTVALET_OWNER=<your-owner-id> npx @agentvalet/register
```

## GitHub OAuth App

The GitHub Device Flow uses AgentValet's OAuth App (client ID is public — the Device Flow does not use or expose the client secret). No secrets are stored on your machine.
