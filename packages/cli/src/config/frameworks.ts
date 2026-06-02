import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import prompts from 'prompts';
import chalk from 'chalk';

export interface DetectedFrameworks {
  codex: boolean;         // codex binary on PATH or ~/.codex exists (CLI / IDE ext)
  codexDesktop: boolean;  // Codex desktop app installed (Mac/Win/Linux)
  claudeCode: boolean;    // claude binary on PATH or ~/.claude exists
  cursor: boolean;        // .cursor/ in cwd OR Cursor IDE app data directory found
  cursorCli: boolean;     // cursor-agent (or `cursor`) binary on PATH (Cursor CLI)
  openclaw: boolean;      // ~/.openclaw exists
  factoryDroid: boolean;  // ~/.factory/ or .factory/ in cwd
}

function tryBinary(cmd: string): boolean {
  try {
    execSync(`${cmd} --version`, { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function codexDesktopInstalled(): boolean {
  // Codex desktop app — Mac/Windows/Linux. The MCP config is shared with the
  // Codex CLI and IDE extension via ~/.codex/config.toml, so we don't need a
  // separate writer — but we detect it so the consent prompt and restart
  // hints can name it explicitly.
  const home = os.homedir();
  const platform = process.platform;

  if (platform === 'darwin') {
    return (
      existsSync('/Applications/Codex.app') ||
      existsSync(path.join(home, 'Applications', 'Codex.app'))
    );
  }
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    return (
      existsSync(path.join(localAppData, 'Programs', 'codex')) ||
      existsSync(path.join(localAppData, 'Programs', 'Codex')) ||
      existsSync(path.join(programFiles, 'Codex'))
    );
  }
  // Linux — AppImage / .desktop entry
  return (
    existsSync('/usr/share/applications/codex.desktop') ||
    existsSync(path.join(home, '.local', 'share', 'applications', 'codex.desktop'))
  );
}

function cursorInstalled(): boolean {
  const home = os.homedir();
  const platform = process.platform;

  if (platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    return (
      existsSync(path.join(appData, 'Cursor')) ||
      existsSync(path.join(localAppData, 'Programs', 'cursor'))
    );
  }
  if (platform === 'darwin') {
    return (
      existsSync(path.join(home, 'Library', 'Application Support', 'Cursor')) ||
      existsSync('/Applications/Cursor.app')
    );
  }
  return (
    existsSync(path.join(home, '.config', 'Cursor')) ||
    existsSync('/usr/share/applications/cursor.desktop')
  );
}

export function detectFrameworks(): DetectedFrameworks {
  const home = os.homedir();
  return {
    codex: existsSync(path.join(home, '.codex')) || tryBinary('codex'),
    codexDesktop: codexDesktopInstalled(),
    claudeCode: existsSync(path.join(home, '.claude')) || tryBinary('claude'),
    cursor: existsSync(path.join(process.cwd(), '.cursor')) || cursorInstalled(),
    cursorCli: tryBinary('cursor-agent'),
    openclaw: existsSync(path.join(home, '.openclaw')),
    factoryDroid: existsSync(path.join(home, '.factory')) || existsSync(path.join(process.cwd(), '.factory')),
  };
}

// Resolve a single agent_type for the agents.agent_type column. The CLI may
// configure several hosts in one run; the column is singular so we pick the
// most prominent host using a fixed precedence order. If the dashboard later
// needs the full set, add an agent_hosts text[] column.
export function resolveAgentType(detected: DetectedFrameworks): string {
  if (detected.claudeCode) return 'claude-code';
  if (detected.codexDesktop) return 'codex-desktop';
  if (detected.codex) return 'codex-cli';
  if (detected.cursor) return 'cursor-ide';
  if (detected.cursorCli) return 'cursor-agent-cli';
  if (detected.factoryDroid) return 'factory-droid';
  if (detected.openclaw) return 'openclaw';
  return 'unknown';
}

export async function frameworkSetupConsent(detected: DetectedFrameworks): Promise<boolean> {
  const items: string[] = [];

  if (detected.claudeCode) {
    items.push('Claude Code  → .mcp.json (MCP server)');
    items.push('             → CLAUDE.md (usage rules)');
  }
  if (detected.cursor || detected.cursorCli) {
    const surfaces: string[] = [];
    if (detected.cursor) surfaces.push('IDE');
    if (detected.cursorCli) surfaces.push('cursor-agent CLI');
    items.push(`Cursor (${surfaces.join(' + ')}) → .cursor/mcp.json (MCP server)`);
  }
  if (detected.codex || detected.codexDesktop) {
    const surfaces: string[] = [];
    if (detected.codex) surfaces.push('Codex CLI');
    if (detected.codexDesktop) surfaces.push('Desktop app');
    items.push(`Codex (${surfaces.join(' + ')}) → ~/.codex/config.toml (MCP server)`);
    items.push('             → AGENTS.md (usage rules)');
  }
  if (detected.openclaw) {
    items.push('OpenClaw     → SKILL.md (usage rules)');
  }
  if (detected.factoryDroid) {
    items.push('Factory Droid → add MCP server to ~/.factory/mcp.json');
    items.push('              → create .factory/droids/agentvalet.yaml');
    items.push('              → create .factory/commands/av-status.md');
  }

  if (items.length === 0) return false;

  console.log('');
  console.log(chalk.bold('  Detected agent frameworks'));
  for (const item of items) {
    console.log(chalk.dim(`    ${item}`));
  }
  console.log('');

  const { confirm } = await prompts({
    type: 'confirm',
    name: 'confirm',
    message: 'Configure these automatically?',
    initial: true,
  });

  return confirm ?? false;
}
