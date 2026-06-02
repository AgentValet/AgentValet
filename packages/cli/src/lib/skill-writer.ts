import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import chalk from 'chalk';

export function writeAgentsMd(): void {
  const dest = path.join(process.cwd(), 'AGENTS.md');

  if (existsSync(dest)) {
    console.log(chalk.dim('  AGENTS.md already exists — skipping'));
    return;
  }

  const content = `# AgentValet — Credential Governance

All external platform API calls must go through the AgentValet proxy.
Never call platform APIs (Slack, Stripe, Gmail, GitHub, etc.) directly.

## Making a platform call

Use the \`use_platform\` MCP tool:

\`\`\`
use_platform({
  platform: "slack",
  endpoint: "/api/chat.postMessage",
  method: "POST",
  scope: "slack:write",
  data: { channel: "#general", text: "Hello" }
})
\`\`\`

## Before any platform session

1. Call \`list_platforms\` to see approved platforms and scopes
2. Call \`authzen_evaluate\` before destructive operations
3. If a call returns \`pending_approval\` — wait, do not retry

## If AgentValet MCP is not available

Do not call platform APIs directly. Tell the user:
"AgentValet MCP is not connected. Run: npx @agentvalet/register"
`;

  writeFileSync(dest, content, 'utf8');
  console.log(chalk.green('  ✓ AGENTS.md created in current directory'));
  console.log(chalk.dim('    Commit this file to your repo'));
}

export function writeSkillMd(): void {
  const dest = path.join(process.cwd(), 'SKILL.md');

  if (existsSync(dest)) {
    console.log(chalk.dim('  SKILL.md already exists — skipping'));
    return;
  }

  const content = `# AgentValet Skill

Routes all platform API calls through AgentValet's credential proxy.

## Making platform calls

Use the \`use_platform\` tool instead of calling APIs directly:

\`\`\`
use_platform({
  platform: "slack",
  endpoint: "/api/chat.postMessage",
  method: "POST",
  scope: "slack:write",
  data: { channel: "#general", text: "Hello" }
})
\`\`\`

## Rules

1. Never call platform APIs directly
2. Call \`list_platforms\` before assuming a platform is available
3. Call \`authzen_evaluate\` before destructive operations
4. Wait for human approval when required — do not retry aggressively

Dashboard: https://app.agentvalet.ai
`;

  writeFileSync(dest, content, 'utf8');
  console.log(chalk.green('  ✓ SKILL.md created in current directory'));
  console.log(chalk.dim('    Commit this file to your repo'));
}

export interface QuickstartOptions {
  agentId: string;
  ownerId: string;
  proxyUrl: string;
  keyPath: string;
  detected: { cursor: boolean; cursorCli?: boolean; claudeCode: boolean; codex: boolean; codexDesktop?: boolean; openclaw: boolean; factoryDroid?: boolean };
}

export function writeQuickstartDoc(opts: QuickstartOptions): void {
  const dest = path.join(process.cwd(), 'AGENTVALET.md');

  if (existsSync(dest)) {
    console.log(chalk.dim('  AGENTVALET.md already exists — skipping'));
    return;
  }

  const { agentId, ownerId, proxyUrl, keyPath, detected } = opts;

  const ideSection = (() => {
    const lines: string[] = [];
    if (detected.cursor) {
      lines.push(`### Cursor
The \`.mcp.json\` in this directory has been configured. Restart Cursor and the AgentValet MCP server will start automatically.`);
    }
    if (detected.claudeCode) {
      lines.push(`### Claude Code
The \`.mcp.json\` in this directory has been configured. Run \`/mcp\` in Claude Code to verify \`agentvalet\` appears in the list.`);
    }
    if (detected.codex) {
      lines.push(`### Codex
\`~/.codex/config.toml\` has been updated with the MCP server block. See \`AGENTS.md\` for platform call instructions.`);
    }
    if (detected.openclaw) {
      lines.push(`### OpenClaw
See \`SKILL.md\` for platform call instructions.`);
    }
    if (detected.factoryDroid) {
      lines.push(`### Factory Droid
\`~/.factory/mcp.json\` has been updated with the AgentValet MCP server block.
Type \`@AgentValet\` in Factory Droid to activate governance. Use \`/av-status\` to verify connections.`);
    }
    if (lines.length === 0) {
      lines.push(`Add the MCP server to your IDE manually. See: https://docs.agentvalet.ai/setup`);
    }
    return lines.join('\n\n');
  })();

  const content = `# AgentValet — Quick Reference

## This agent

| | |
|---|---|
| Agent ID | \`${agentId}\` |
| Owner ID | \`${ownerId}\` |
| Proxy URL | \`${proxyUrl}\` |
| Private key | \`${keyPath}\` |

Dashboard: https://app.agentvalet.ai
Activate or manage this agent at: https://app.agentvalet.ai/agents

---

## CLI commands

| Command | What it does |
|---|---|
| \`npx @agentvalet/register\` | Register a new agent or re-run setup |
| \`npx @agentvalet/register refresh\` | Refresh approved platform permissions |

> These commands use \`npx\` — you do not need to install the package globally.

---

## IDE setup

${ideSection}

---

## Environment variables

Set these wherever your IDE agent reads environment from:

\`\`\`
AGENT_ID=${agentId}
OWNER_ID=${ownerId}
PROXY_URL=${proxyUrl}
AGENT_PRIVATE_KEY_PATH=${keyPath}
\`\`\`
`;

  writeFileSync(dest, content, 'utf8');
  console.log(chalk.green('  ✓ AGENTVALET.md created — quick reference for this agent'));
  console.log(chalk.dim('    Add to .gitignore if it contains sensitive paths'));
}

export function writeFactoryDroidDroid(): void {
  const droidsDir = path.join(process.cwd(), '.factory', 'droids');
  if (!existsSync(droidsDir)) mkdirSync(droidsDir, { recursive: true });

  const dest = path.join(droidsDir, 'agentvalet.yaml');
  if (existsSync(dest)) {
    console.log(chalk.dim('  Factory Droid: .factory/droids/agentvalet.yaml already exists'));
    return;
  }

  const content = `# AgentValet Governance Droid
# Automatically created by @agentvalet/register
# Commit this file to your repo

name: AgentValet
description: >
  Routes all platform API calls through AgentValet's credential
  proxy. Enforces per-agent permissions, rate limits, and human
  approval for high-risk operations. Every call is logged.

model: inherit

mcp_servers:
  - agentvalet

autonomy: Low

instructions: |
  You are operating under AgentValet credential governance.

  ## Rules — read before every platform call

  1. NEVER call platform APIs (Slack, Stripe, Gmail, GitHub, etc.) directly.
     Always use the \`use_platform\` MCP tool.

  2. Call \`list_platforms\` at the start of any session that involves
     platform calls. Do not assume platforms are available.

  3. Call \`authzen_evaluate\` before any destructive operation
     (delete, send, charge, publish). Do not proceed if decision=false.

  4. If \`use_platform\` returns \`{ status: "pending_approval" }\`,
     wait for human approval. Do not retry the call.

  5. If AgentValet MCP tools are unavailable, stop and tell the user:
     "AgentValet MCP is not connected. Run: npx @agentvalet/register"
     Do not attempt platform calls without governance.

  ## Making a platform call

  \`\`\`
  use_platform({
    platform: "slack",
    endpoint: "/api/chat.postMessage",
    method: "POST",
    scope: "slack:write",
    data: { channel: "#general", text: "Hello" }
  })
  \`\`\`

  ## Scope categories

  - Read scopes (*.read, *.list) — lower risk, may auto-approve
  - Write scopes (*.write, *.create) — check authzen_evaluate first
  - Destructive scopes (*.delete, stripe:charge, mail:send) — always
    call authzen_evaluate, always inform user before proceeding

  Dashboard: https://app.agentvalet.ai
  Docs: https://docs.agentvalet.ai
`;

  writeFileSync(dest, content, 'utf8');
  console.log(chalk.green('  ✓ Factory Droid: created .factory/droids/agentvalet.yaml'));
  console.log(chalk.dim('    Commit this file to your repo'));
}

export function writeFactoryDroidCommand(): void {
  const commandsDir = path.join(process.cwd(), '.factory', 'commands');
  if (!existsSync(commandsDir)) mkdirSync(commandsDir, { recursive: true });

  const statusDest = path.join(commandsDir, 'av-status.md');
  if (!existsSync(statusDest)) {
    const statusContent = `# /av-status

Check your AgentValet agent status and approved platform connections.

## Instructions for the droid

1. Call \`list_platforms\` using the AgentValet MCP server
2. Display the results in a clean table:
   - Platform name
   - Approved scopes
   - Whether any scope requires human approval
3. If no platforms are approved yet, tell the user to visit
   https://app.agentvalet.ai/agents to configure permissions
4. If AgentValet MCP is not connected, explain how to set it up:
   Run: npx @agentvalet/register
`;
    writeFileSync(statusDest, statusContent, 'utf8');
    console.log(chalk.green('  ✓ Factory Droid: created .factory/commands/av-status.md'));
  } else {
    console.log(chalk.dim('  Factory Droid: .factory/commands/av-status.md already exists'));
  }

  const registerDest = path.join(commandsDir, 'av-register.md');
  if (!existsSync(registerDest)) {
    const registerContent = `# /av-register

Register or re-register this project with AgentValet.

## Instructions for the droid

Tell the user to run the following command in their terminal:

\`\`\`bash
npx @agentvalet/register
\`\`\`

This will:
1. Authenticate with GitHub (opens browser)
2. Create or find their AgentValet account
3. Register this machine as an agent
4. Configure Factory Droid MCP integration automatically

After running, approve the agent at: https://app.agentvalet.ai/agents
`;
    writeFileSync(registerDest, registerContent, 'utf8');
    console.log(chalk.green('  ✓ Factory Droid: created .factory/commands/av-register.md'));
  }
}

export function writeFactoryDroidReliabilityDroid(): void {
  const droidsDir = path.join(process.cwd(), '.factory', 'droids');
  if (!existsSync(droidsDir)) mkdirSync(droidsDir, { recursive: true });

  const dest = path.join(droidsDir, 'agentvalet-reliability.yaml');
  if (existsSync(dest)) return;

  const content = `# AgentValet Reliability Droid
# Monitors agent call patterns and surfaces governance issues
# Commit this file to your repo

name: AgentValet Reliability
description: >
  Monitors AI agent behaviour against AgentValet governance rules.
  Surfaces approval-required actions, scope violations, rate limit
  warnings, and audit anomalies directly in Factory Droid.

type: reliability
model: inherit
mcp_servers:
  - agentvalet
autonomy: Low

triggers:
  - on_agent_action: true
  - on_approval_required: true
  - on_scope_violation: true

instructions: |
  You are a governance monitor. You observe what the other droids
  are doing and flag any actions that require human oversight.

  ## Your responsibilities

  1. BEFORE any droid makes a platform API call, check if the scope
     requires approval using \`authzen_evaluate\`:
     - If decision=false: block the call, explain why, suggest alternatives
     - If decision=true: allow, but log it

  2. WHEN a droid calls \`use_platform\`, verify:
     - The platform is in the approved list from \`list_platforms\`
     - The scope matches what was approved
     - The call hasn't exceeded rate limits

  3. SURFACE approval-required actions clearly:
     "⚠ This action requires human approval: [action description]
      Waiting for approval at app.agentvalet.ai/approvals"

  4. MONITOR for unusual patterns:
     - Multiple calls to the same destructive scope in quick succession
     - Calls to platforms not in the approved list
     - Call volume spikes beyond normal operation

  5. REPORT governance status when asked:
     - Current approved platforms and scopes
     - Pending approvals
     - Recent audit log entries (call list_platforms + agent_status)

  ## What you do NOT do

  - You do not make platform API calls yourself
  - You do not approve actions on behalf of the human
  - You do not bypass governance even if another droid requests it

  ## Escalation

  If you detect a potential security concern (unexpected scope,
  unusual call pattern), immediately tell the human:
  "🔴 Governance alert: [description]. Recommend reviewing at
  app.agentvalet.ai/audit"
`;

  writeFileSync(dest, content, 'utf8');
  console.log(chalk.green('  ✓ Factory Droid: created .factory/droids/agentvalet-reliability.yaml'));
  console.log(chalk.dim('    Commit this file to your repo'));
}

export function ensureMcpServer(): void {
  try {
    execSync('npx --yes @agentvalet/mcp-server --version', {
      stdio: 'ignore',
      timeout: 10_000,
    });
  } catch {
    // npx will fetch on first use — not an error
    console.log(chalk.dim('  @agentvalet/mcp-server will be fetched on first use via npx'));
  }
}

interface Permission {
  platformId: string;
  platformName: string;
  scopes: string[];
  requireApproval: boolean;
}

export function generatePermissionsFile(agentId: string, ownerId: string, permissions: Permission[]): string {
  const now = new Date().toISOString();

  const platformSections = permissions.length === 0
    ? "_No platforms approved yet. Visit https://app.agentvalet.ai to connect platforms._"
    : permissions.map((p) => {
        const scopeList = p.scopes.map((s) => `  - \`${s}\``).join("\n");
        const approvalNote = p.requireApproval ? "\n  > Requires human approval before executing.\n" : "";
        return `### ${p.platformName} (\`${p.platformId}\`)\n\nApproved scopes:\n${scopeList}\n${approvalNote}`;
      }).join("\n\n");

  return `# AgentValet Permissions

Agent ID: \`${agentId}\`
Owner ID: \`${ownerId}\`
Last refreshed: ${now}

---

## Approved Platforms

${platformSections}

---

## How to call a platform

All platform calls **must** go through the \`mcp__agentvalet__use_platform\` MCP tool.

**NEVER** write inline JWT signing code, \`node -e\` scripts, or manual HTTP calls. The MCP tool handles all authentication internally.

\`\`\`
mcp__agentvalet__use_platform({
  platform: "<platformId>",
  endpoint: "<endpoint>",
  method: "POST",
  scope: "<scope>",
  data: { ... }
})
\`\`\`

To refresh this file: \`npx @agentvalet/register refresh\`
`;
}
