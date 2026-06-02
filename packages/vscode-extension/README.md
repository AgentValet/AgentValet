# AgentValet for VSCode

Secure credential proxy and governance for your AI agents.

## Features

- **Zero-click registration** — if you're already signed into GitHub in VSCode, AgentValet registers your workspace as an agent automatically
- **Status bar** — see your agent status at a glance
- **One-click dashboard** — open the AgentValet dashboard directly from VSCode

## How it works

1. Install the extension
2. If you're signed into GitHub: you'll see a notification that your agent is registered within a few seconds. No other action needed.
3. If you're not signed into GitHub: run `AgentValet: Register this workspace as an agent` from the Command Palette (Ctrl+Shift+P / Cmd+Shift+P)
4. Approve your agent in the AgentValet dashboard

## Commands

| Command | Description |
|---|---|
| `AgentValet: Register this workspace as an agent` | Manual registration |
| `AgentValet: Open dashboard` | Open app.agentvalet.ai |
| `AgentValet: Show agent status` | View status and quick actions |
| `AgentValet: Copy proxy URL` | Copy your proxy URL to clipboard |
| `AgentValet: Sign out` | Remove local registration |

## Settings

| Setting | Default | Description |
|---|---|---|
| `agentvalet.autoRegister` | `true` | Auto-register on startup |
| `agentvalet.showStatusBar` | `true` | Show status bar item |
| `agentvalet.apiUrl` | `https://api.agentvalet.ai` | API URL (advanced) |

## Works in

- Visual Studio Code 1.85+
- Cursor
- Windsurf
- Gitpod
- Any VSCode-compatible editor

## After registration

Approve your agent in the dashboard to activate it:
[app.agentvalet.ai/agents](https://app.agentvalet.ai/agents)

Your agent credentials are stored securely in the OS keychain via VSCode's Secret Storage — never in plaintext files.
