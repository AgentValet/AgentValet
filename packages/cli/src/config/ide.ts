import { mkdir, writeFile, readFile, appendFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { DetectedFrameworks } from './frameworks.js';

export type ConfigScope = 'user' | 'project';

interface McpConfigParams {
  agentId: string;
  ownerId: string;
  proxyUrl: string;
  keyPath: string;  // absolute path to agent.key
  detected: DetectedFrameworks;
  scope?: ConfigScope;  // default: 'user'
}

function buildMcpEntry(params: Omit<McpConfigParams, 'detected'>) {
  return {
    command: 'npx',
    args: ['-y', '@agentvalet/register', 'mcp-server'],
    env: {
      AGENT_ID: params.agentId,
      OWNER_ID: params.ownerId,
      PROXY_URL: params.proxyUrl,
      AGENT_PRIVATE_KEY_PATH: params.keyPath,
    },
  };
}

async function mergeJsonFile(filePath: string, key: string, value: unknown): Promise<void> {
  let existing: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    try {
      const text = await readFile(filePath, 'utf8');
      existing = JSON.parse(text);
    } catch {
      // overwrite if unreadable
    }
  }

  const mcpServers = (existing.mcpServers as Record<string, unknown>) ?? {};
  mcpServers[key] = value;
  existing.mcpServers = mcpServers;

  await writeFile(filePath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
}

function buildClaudeMd(agentId: string, ownerId: string, proxyUrl: string): string {
  return `# AgentValet — Credential Governance

Agent ID: \`${agentId}\`
Owner ID: \`${ownerId}\`

All external platform API calls **must** go through the AgentValet proxy.
Never call platform APIs (Slack, Stripe, Gmail, GitHub, etc.) directly.

## Making a platform call

Use the \`mcp__agentvalet__use_platform\` MCP tool:

\`\`\`
mcp__agentvalet__use_platform({
  platform: "slack",
  endpoint: "/api/chat.postMessage",
  method: "POST",
  scope: "slack:write",
  data: { channel: "#general", text: "Hello" }
})
\`\`\`

## Before any platform session

1. Call \`mcp__agentvalet__list_platforms\` to see approved platforms and scopes
2. Call \`mcp__agentvalet__authzen_evaluate\` before destructive operations
3. If a call returns \`pending_approval\` — wait, do not retry

## Rules

- **NEVER** write inline JWT signing code, \`node -e\` scripts, or manual HTTP calls
- The MCP tool handles authentication automatically
- \`AGENT_PRIVATE_KEY_PATH\` points to your key — do not read or log it

## If AgentValet MCP is not connected

Tell the user: "AgentValet MCP is not connected. Run: npx @agentvalet/register"

Dashboard: ${proxyUrl.replace('api.', 'app.')}
`;
}

interface GlobalFrameworkParams {
  agentId: string;
  ownerId: string;
  proxyUrl: string;
  keyPath: string;  // absolute path to agent.key
}

// Build the [mcp_servers.agentvalet] TOML block. Same shape works for Codex
// CLI, IDE extension, and Desktop app — they all read the same config.toml.
function buildCodexTomlBlock(params: Omit<McpConfigParams, 'detected'>): string {
  return `
[mcp_servers.agentvalet]
command = "npx"
args = ["-y", "@agentvalet/register", "mcp-server"]
env = { AGENT_ID = "${params.agentId}", OWNER_ID = "${params.ownerId}", PROXY_URL = "${params.proxyUrl}", AGENT_PRIVATE_KEY_PATH = "${params.keyPath.replace(/\\/g, '/')}" }
`;
}

// Append the agentvalet block to a Codex config.toml, creating the directory
// if needed. Returns the friendly path written, or null if no change was made.
async function appendCodexConfig(configPath: string): Promise<boolean> {
  const dir = path.dirname(configPath);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const existing = existsSync(configPath) ? await readFile(configPath, 'utf8') : '';
  if (existing.includes('[mcp_servers.agentvalet]')) return false;
  return true;
}

export async function writeGlobalFrameworkConfigs(params: GlobalFrameworkParams): Promise<string[]> {
  const written: string[] = [];

  // ── Codex (CLI + IDE extension + Desktop app) ──────────────────
  // All three Codex surfaces share ~/.codex/config.toml. MCP servers use
  // [mcp_servers.name] syntax. We use AGENT_PRIVATE_KEY_PATH (file path)
  // rather than inlining the PEM so the key never sits inside a
  // world-readable config file.
  const codexDir = path.join(os.homedir(), '.codex');
  const codexConfigPath = path.join(codexDir, 'config.toml');
  // Always create ~/.codex/ if any Codex surface is present — the desktop app
  // doesn't necessarily create it on install, but reads from it at startup.
  try {
    if (!existsSync(codexDir)) await mkdir(codexDir, { recursive: true });
    if (await appendCodexConfig(codexConfigPath)) {
      await appendFile(codexConfigPath, buildCodexTomlBlock(params), 'utf8');
      written.push('~/.codex/config.toml');
    }
  } catch (err: any) {
    console.warn(`  Warning: could not write Codex config: ${err.message}`);
  }

  return written;
}

// Project-scoped Codex config: .codex/config.toml in cwd. Codex reads this
// only for trusted projects. Caller is responsible for deciding scope.
async function writeCodexProjectConfig(params: Omit<McpConfigParams, 'detected'>): Promise<string[]> {
  const cwd = process.cwd();
  const configPath = path.join(cwd, '.codex', 'config.toml');
  const written: string[] = [];
  try {
    if (await appendCodexConfig(configPath)) {
      await appendFile(configPath, buildCodexTomlBlock(params), 'utf8');
      written.push('.codex/config.toml');
    }
  } catch (err: any) {
    console.warn(`  Warning: could not write .codex/config.toml: ${err.message}`);
  }
  return written;
}

// Strip the agentvalet entry from a JSON file with { mcpServers: {...} } shape.
// Returns true if the file existed and an entry was removed.
async function stripAgentvaletFromMcpJson(filePath: string): Promise<boolean> {
  if (!existsSync(filePath)) return false;
  try {
    const text = await readFile(filePath, 'utf8');
    const config = JSON.parse(text) as Record<string, unknown>;
    const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
    if (!servers.agentvalet) return false;
    delete servers.agentvalet;
    config.mcpServers = servers;
    await writeFile(filePath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

// When installing user-scoped, remove any old project-scoped agentvalet entries
// so the user has a single source of truth.
async function cleanProjectScopedEntries(): Promise<string[]> {
  const cleaned: string[] = [];
  const cwd = process.cwd();

  if (await stripAgentvaletFromMcpJson(path.join(cwd, '.mcp.json'))) {
    cleaned.push('.mcp.json (project entry removed)');
  }
  if (await stripAgentvaletFromMcpJson(path.join(cwd, '.cursor/mcp.json'))) {
    cleaned.push('.cursor/mcp.json (project entry removed)');
  }
  // Factory Droid project mcp.json uses flat structure (no mcpServers wrapper)
  const factoryProjectMcp = path.join(cwd, '.factory/mcp.json');
  if (existsSync(factoryProjectMcp)) {
    try {
      const text = await readFile(factoryProjectMcp, 'utf8');
      const config = JSON.parse(text) as Record<string, unknown>;
      if (config.agentvalet) {
        delete config.agentvalet;
        await writeFile(factoryProjectMcp, JSON.stringify(config, null, 2) + '\n', 'utf8');
        cleaned.push('.factory/mcp.json (project entry removed)');
      }
    } catch { /* ignore */ }
  }

  return cleaned;
}

export async function writeIdeConfigs(params: McpConfigParams): Promise<string[]> {
  const { detected, scope = 'user', ...mcpParams } = params;
  const cwd = process.cwd();
  const home = os.homedir();
  const written: string[] = [];
  const entry = buildMcpEntry(mcpParams);

  if (scope === 'user') {
    // ── Claude Code: ~/.claude.json (user-scoped, no trust prompt) ──
    if (detected.claudeCode) {
      const claudeUserConfig = path.join(home, '.claude.json');
      try {
        await mergeJsonFile(claudeUserConfig, 'agentvalet', entry);
        written.push('~/.claude.json');
      } catch (err: any) {
        console.warn(`  Warning: could not write ~/.claude.json: ${err.message}`);
      }
    }

    // ── Cursor IDE + cursor-agent CLI: ~/.cursor/mcp.json ────────────
    // Both surfaces share the same config file (project precedence: .cursor/
    // mcp.json in cwd > ~/.cursor/mcp.json). One writer covers both.
    if (detected.cursor || detected.cursorCli) {
      const cursorUserDir = path.join(home, '.cursor');
      const cursorUserMcp = path.join(cursorUserDir, 'mcp.json');
      try {
        await mkdir(cursorUserDir, { recursive: true });
        await mergeJsonFile(cursorUserMcp, 'agentvalet', entry);
        written.push('~/.cursor/mcp.json');
      } catch (err: any) {
        console.warn(`  Warning: could not write ~/.cursor/mcp.json: ${err.message}`);
      }
    }

    // ── Factory Droid: ~/.factory/mcp.json (already user-scoped) ────
    if (detected.factoryDroid) {
      const fdResults = await writeFactoryDroidConfig({ ...mcpParams, scope: 'user' });
      written.push(...fdResults);
    }

    // Clean any leftover project-scoped agentvalet entries from cwd
    const cleaned = await cleanProjectScopedEntries();
    written.push(...cleaned);
  } else {
    // ── PROJECT scope ───────────────────────────────────────────────
    // Claude Code: .mcp.json + CLAUDE.md
    if (detected.claudeCode) {
      const claudeMcpPath = path.join(cwd, '.mcp.json');
      try {
        await mergeJsonFile(claudeMcpPath, 'agentvalet', entry);
        written.push('.mcp.json');
      } catch (err: any) {
        console.warn(`  Warning: could not write .mcp.json: ${err.message}`);
      }

      const claudeMdPath = path.join(cwd, 'CLAUDE.md');
      if (!existsSync(claudeMdPath)) {
        try {
          await writeFile(claudeMdPath, buildClaudeMd(params.agentId, params.ownerId, params.proxyUrl), 'utf8');
          written.push('CLAUDE.md');
        } catch (err: any) {
          console.warn(`  Warning: could not write CLAUDE.md: ${err.message}`);
        }
      } else {
        written.push('CLAUDE.md (already exists — skipped)');
      }
    }

    // Cursor IDE + cursor-agent CLI: .cursor/mcp.json (project scope)
    if (detected.cursor || detected.cursorCli) {
      const cursorDir = path.join(cwd, '.cursor');
      const cursorMcpPath = path.join(cursorDir, 'mcp.json');
      try {
        await mkdir(cursorDir, { recursive: true });
        await mergeJsonFile(cursorMcpPath, 'agentvalet', entry);
        written.push('.cursor/mcp.json');
      } catch (err: any) {
        console.warn(`  Warning: could not write .cursor/mcp.json: ${err.message}`);
      }
    }

    // Factory Droid: project-scoped (.factory/mcp.json)
    if (detected.factoryDroid) {
      const fdResults = await writeFactoryDroidConfig({ ...mcpParams, scope: 'project' });
      written.push(...fdResults);
    }

    // Codex: project-scoped (.codex/config.toml — trusted projects only)
    // Covers Codex CLI, IDE extension, and Desktop app — all three read this
    // file when the project is trusted.
    if (detected.codex || detected.codexDesktop) {
      const codexResults = await writeCodexProjectConfig(mcpParams);
      written.push(...codexResults);
    }
  }

  return written;
}

// Factory Droid uses a flat JSON structure (no mcpServers wrapper)
async function mergeFactoryDroidMcpJson(filePath: string, key: string, value: unknown): Promise<void> {
  let existing: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    try {
      const text = await readFile(filePath, 'utf8');
      existing = JSON.parse(text);
    } catch {
      await copyFile(filePath, filePath + '.backup');
    }
  }

  if (existing[key]) return; // already configured — don't overwrite

  existing[key] = value;
  await writeFile(filePath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
}

async function updateGitignoreForFactoryDroid(): Promise<void> {
  const gitignorePath = path.join(process.cwd(), '.gitignore');
  if (!existsSync(gitignorePath)) return;

  const existing = await readFile(gitignorePath, 'utf8');
  if (existing.includes('.factory/mcp.json')) return;

  const additions = [
    '',
    '# Factory Droid — private key in MCP config',
    '.factory/mcp.json',
    '',
    '# Factory Droid — commit these:',
    '# .factory/droids/',
    '# .factory/commands/',
  ].join('\n');

  await appendFile(gitignorePath, additions + '\n', 'utf8');
}

export async function writeFactoryDroidConfig(params: Omit<McpConfigParams, 'detected'>): Promise<string[]> {
  const home = os.homedir();
  const written: string[] = [];
  const entry = buildMcpEntry(params);
  const scope = params.scope ?? 'user';

  const globalDir = path.join(home, '.factory');
  const projectDir = path.join(process.cwd(), '.factory');

  if (scope === 'user') {
    // Always write to global config; create the dir if Factory Droid is
    // installed but hasn't been launched yet.
    try {
      await mkdir(globalDir, { recursive: true });
      await mergeFactoryDroidMcpJson(path.join(globalDir, 'mcp.json'), 'agentvalet', entry);
      written.push('~/.factory/mcp.json');
    } catch (err: any) {
      console.warn(`  Warning: could not write ~/.factory/mcp.json: ${err.message}`);
    }
  } else {
    // Project scope: write to .factory/mcp.json in cwd
    try {
      await mkdir(projectDir, { recursive: true });
      await mergeFactoryDroidMcpJson(path.join(projectDir, 'mcp.json'), 'agentvalet', entry);
      written.push('.factory/mcp.json');
    } catch (err: any) {
      console.warn(`  Warning: could not write .factory/mcp.json: ${err.message}`);
    }
    try { await updateGitignoreForFactoryDroid(); } catch { /* non-fatal */ }
  }

  return written;
}
