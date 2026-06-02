# @agentvalet/agents-md

Instruction files for AI agent frameworks to use AgentValet's
credential proxy for all platform API calls.

## What's included

- `AGENTS.md` — for Codex CLI, Codex VSCode, Codex Desktop
- `CLAUDE.md` — for Claude Code
- `SKILL.md` — for OpenClaw and winClaw

## Usage

### Option 1 — Copy files to your project

```bash
npm install @agentvalet/agents-md
```

Files are copied to your project root automatically on install.
Review them and commit to your repo.

### Option 2 — Reference in your existing AGENTS.md

Add this to your existing `AGENTS.md`:

```markdown
## AgentValet

See: node_modules/@agentvalet/agents-md/AGENTS.md
```

### Option 3 — Download directly

```bash
curl -O https://raw.githubusercontent.com/agentvalet/agentvalet/main/docs/AGENTS.md
```

## Why use these files

Without instruction files, an AI agent has to be told every session
to use AgentValet. With AGENTS.md/CLAUDE.md in the project root, the
agent reads them on startup and already knows the rules — no per-session
instruction needed.

These files work alongside the AgentValet MCP server:
- MCP server = the tools (`use_platform`, `list_platforms`, etc.)
- These files = the rules (when and how to use the tools)
