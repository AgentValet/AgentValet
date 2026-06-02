import chalk from 'chalk';
import ora from 'ora';
import prompts from 'prompts';
import { browserLogin } from '../auth/browser-flow.js';
import { registerAgent } from '../api/agentvalet.js';
import { getStoredConfig, saveConfig, isAuthenticated, clearConfig } from '../config/store.js';
import { writeLocalConfig } from '../config/local.js';
import { formatEnvBlock } from '../output/env.js';
import { writeIdeConfigs, writeGlobalFrameworkConfigs } from '../config/ide.js';
import { detectFrameworks, frameworkSetupConsent, resolveAgentType } from '../config/frameworks.js';
import { writeAgentsMd, writeSkillMd, ensureMcpServer, writeQuickstartDoc, writeFactoryDroidDroid, writeFactoryDroidCommand, writeFactoryDroidReliabilityDroid } from '../lib/skill-writer.js';
import os from 'node:os';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

export async function runOnboard(opts: { scope?: 'user' | 'project'; name?: string } = {}) {
  const scope: 'user' | 'project' = opts.scope ?? 'user';
  const presetName = opts.name?.trim() || undefined;
  console.log('');
  console.log(chalk.bold('  AgentValet — Agent Registration'));
  console.log(chalk.dim('  app.agentvalet.ai'));
  console.log('');

  // ── Step 1: Check if already authenticated ────────────────────

  if (isAuthenticated()) {
    const stored = getStoredConfig();
    console.log(
      chalk.green('  ✓ Already authenticated as') +
      chalk.bold(` ${stored.email}`)
    );

    const { action } = await prompts({
      type: 'select',
      name: 'action',
      message: 'What would you like to do?',
      choices: [
        { title: 'Register a new agent for this directory', value: 'register' },
        { title: 'Show my credentials', value: 'show' },
        { title: 'Sign out and use a different account', value: 'signout' },
      ],
    });

    if (action === undefined) { process.exit(0); }

    if (action === 'show') {
      showCredentials(stored);
      return;
    }
    if (action === 'signout') {
      clearConfig();
      console.log(chalk.dim('  Signed out. Run again to re-authenticate.'));
      return;
    }
    // continue to agent registration with stored config
    await registerAgentFlow(stored.cliToken!, stored.ownerId!, scope, presetName);
    return;
  }

  // ── Step 2: Browser-based login ───────────────────────────────
  // (The legacy "Paste Owner ID" path was removed for security — UUIDs are
  // not secrets and were being treated as bearer tokens. Browser flow uses
  // proper Clerk auth via app.agentvalet.ai/cli-auth.)

  let credentials: Awaited<ReturnType<typeof browserLogin>>;
  try {
    credentials = await browserLogin();
  } catch (err: any) {
    console.error(chalk.red(`\n  ✗ Authentication failed: ${err.message}`));
    process.exit(1);
  }

  console.log(chalk.green(`  ✓ Signed in${credentials!.email ? ' as ' + chalk.bold(credentials!.email) : ''}`));

  // Store account config
  saveConfig({
    apiKey: credentials!.ownerId,
    ownerId: credentials!.ownerId,
    orgId: credentials!.orgId ?? undefined,
    proxyUrl: credentials!.proxyUrl,
    email: credentials!.email ?? '',
    cliToken: credentials!.cliToken,
  });

  // ── Step 4: Register this machine as an agent ─────────────────

  await registerAgentFlow(credentials!.cliToken, credentials!.ownerId, scope, presetName);
}

async function registerAgentFlow(apiKey: string, ownerId: string, scope: 'user' | 'project' = 'user', presetName?: string) {
  const hostname = os.hostname().split('.')[0];
  const dirName = path.basename(process.cwd()) || 'agent';

  let agentName: string;
  if (presetName) {
    agentName = presetName;
    console.log(chalk.dim(`  Agent name: ${chalk.bold(agentName)}`));
  } else {
    const answer = await prompts({
      type: 'text',
      name: 'agentName',
      message: 'Name for this agent:',
      initial: `${hostname} — ${dirName}`,
      validate: v => v.trim().length > 0 || 'Agent name is required',
    });
    if (answer.agentName === undefined) { process.exit(0); }
    agentName = answer.agentName;
  }

  const detectedAtRegister = detectFrameworks();
  const agentType = resolveAgentType(detectedAtRegister);

  const spinner = ora('  Registering agent...').start();
  let agent: Awaited<ReturnType<typeof registerAgent>>;

  try {
    agent = await registerAgent({
      owner_id: ownerId,
      name: agentName.trim(),
      source: 'cli',
      agent_type: agentType,
    }, apiKey);

    spinner.succeed(`  Agent registered: ${chalk.bold(agent.agent_id)}`);
  } catch (err: any) {
    spinner.fail(`  Registration failed: ${err.message}`);
    process.exit(1);
  }

  const keyPath = path.join(process.cwd(), '.agentvalet', 'agent.key');
  const proxyUrl = getStoredConfig().proxyUrl!;

  try {
    await writeLocalConfig({
      agentId: agent!.agent_id,
      agentName: agent!.agent_name,
      proxyUrl,
      privateKeyPem: agent!.private_key_pem,
    });
    saveConfig({ lastAgentId: agent!.agent_id, lastKeyPath: keyPath });
  } catch (err: any) {
    console.error(chalk.red(`  ✗ Failed to write local config: ${err.message}`));
    console.log(chalk.dim('  Agent was registered — run again to save config locally.'));
    process.exit(1);
  }

  // Write .env.agentvalet so the `refresh` command and legacy tooling can find credentials
  try {
    const envContent = [
      '# AgentValet — generated by agentvalet-register',
      `AGENTVALET_AGENT_ID=${agent!.agent_id}`,
      `AGENTVALET_OWNER_ID=${ownerId}`,
      `AGENTVALET_API_URL=${proxyUrl}`,
      `AGENTVALET_PRIVATE_KEY_PATH=${keyPath}`,
    ].join('\n') + '\n';
    await writeFile(path.join(process.cwd(), '.env.agentvalet'), envContent, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // non-fatal — local config is the authoritative store
  }

  const detected = detectFrameworks();
  const shouldSetup = await frameworkSetupConsent(detected);

  let installReliabilityDroid = false;
  if (detected.factoryDroid && shouldSetup) {
    const { reliability } = await prompts({
      type: 'confirm',
      name: 'reliability',
      message: 'Also install AgentValet Reliability Droid for Factory Droid? (monitors agent governance)',
      initial: false,
    });
    installReliabilityDroid = reliability ?? false;
  }

  if (shouldSetup) {
    console.log('');
    console.log(chalk.bold('  Configuring agent frameworks...'));
    console.log('');

    const ideResults = await writeIdeConfigs({
      agentId: agent!.agent_id,
      ownerId,
      proxyUrl,
      keyPath,
      detected,
      scope,
    });
    for (const r of ideResults) {
      console.log(chalk.green(`  ✓ ${r}`));
    }

    const globalResults = await writeGlobalFrameworkConfigs({
      agentId: agent!.agent_id,
      ownerId,
      proxyUrl,
      keyPath,
    });
    for (const r of globalResults) {
      console.log(chalk.green(`  ✓ ${r}`));
    }

    // Project-only artefacts: only emit when user explicitly chose project scope.
    // In user scope (default), the CLI doesn't litter cwd with skill files —
    // the MCP servers in user-scoped configs are enough for governance.
    if (scope === 'project') {
      if (detected.codex || detected.codexDesktop) writeAgentsMd();
      if (detected.openclaw) writeSkillMd();
      if (detected.factoryDroid) {
        writeFactoryDroidDroid();
        writeFactoryDroidCommand();
        if (installReliabilityDroid) writeFactoryDroidReliabilityDroid();
      }
      writeQuickstartDoc({
        agentId: agent!.agent_id,
        ownerId,
        proxyUrl,
        keyPath,
        detected,
      });
    }

    ensureMcpServer();
  } else if (shouldSetup === false) {
    console.log('');
    console.log(chalk.dim('  To configure agent frameworks manually:'));
    console.log(chalk.dim('  https://docs.agentvalet.ai/setup'));
  }

  console.log('');
  console.log(chalk.bold.green('  ✓ All done!'));
  console.log('');
  console.log('  Set these in your environment:');
  console.log('');
  console.log(formatEnvBlock({
    AGENT_ID: agent!.agent_id,
    OWNER_ID: ownerId,
    PROXY_URL: getStoredConfig().proxyUrl!,
    AGENT_PRIVATE_KEY_PATH: path.join(process.cwd(), '.agentvalet', 'agent.key'),
  }));
  console.log('');
  console.log(chalk.dim('  Private key also saved to: .agentvalet/agent.key'));
  console.log(chalk.dim('  Add .agentvalet/ to your .gitignore'));
  console.log('');
  console.log(
    `  Dashboard: ${chalk.cyan.underline('https://app.agentvalet.ai')}`
  );
  console.log(chalk.dim('  Approve this agent in your dashboard to activate it.'));
  console.log('');
  if (shouldSetup) {
    if (scope === 'user') {
      const restartList: string[] = [];
      if (detected.claudeCode) restartList.push('Claude Code');
      if (detected.cursor) restartList.push('Cursor IDE');
      if (detected.cursorCli) restartList.push('cursor-agent CLI (next session picks it up automatically)');
      if (detected.factoryDroid) restartList.push('Factory Droid');
      if (detected.codex) restartList.push('Codex CLI');
      if (detected.codexDesktop) restartList.push('Codex Desktop app (approve "agentvalet" in Settings → MCP)');
      if (restartList.length > 0) {
        console.log(chalk.dim('  Restart these to pick up the new MCP server (no trust prompt — user-scoped):'));
        for (const r of restartList) console.log(chalk.dim(`      ${r}`));
        console.log('');
      }
    } else {
      if (detected.claudeCode) {
        console.log(chalk.yellow('  ⚠ Claude Code: project MCPs require trust on first run.'));
        console.log(chalk.dim('      In your Claude Code session, run:  /mcp'));
        console.log(chalk.dim('      Approve "agentvalet" to load the tools.'));
        console.log('');
      }
      if (detected.cursor) {
        console.log(chalk.dim('  Cursor IDE: restart Cursor (or reopen the workspace) to pick up the MCP.'));
      }
      if (detected.cursorCli) {
        console.log(chalk.dim('  cursor-agent CLI: next `cursor-agent` invocation will pick up the MCP — verify with `cursor-agent mcp list`.'));
      }
      if (detected.factoryDroid) {
        console.log(chalk.dim('  Factory Droid: restart Factory to pick up the MCP.'));
      }
      if (detected.codex) {
        console.log(chalk.dim('  Codex CLI: start a new codex session to pick up the MCP.'));
      }
      if (detected.codexDesktop) {
        console.log(chalk.dim('  Codex Desktop: trust this project, then approve "agentvalet" in Settings → MCP.'));
      }
      console.log('');
    }
  }

  console.log('  Useful commands:');
  console.log(chalk.dim('    npx @agentvalet/register          — register another agent'));
  console.log(chalk.dim('    npx @agentvalet/register refresh  — refresh approved permissions'));
  console.log('');
}

function showCredentials(config: Partial<any>) {
  console.log('');
  console.log('  Your AgentValet credentials:');
  console.log('');
  console.log(`  Owner ID:  ${chalk.bold(config.ownerId)}`);
  console.log(`  Proxy URL: ${chalk.bold(config.proxyUrl)}`);
  console.log(`  Email:     ${chalk.bold(config.email)}`);
  console.log('');
}
