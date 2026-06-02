import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { Command } from 'commander';
import chalk from 'chalk';
import prompts from 'prompts';
import { AGENT_DIR, AGENT_KEY_PATH, saveConfig } from '../config/store.js';
import { detectFrameworks, frameworkSetupConsent } from '../config/frameworks.js';
import { writeIdeConfigs, writeGlobalFrameworkConfigs } from '../config/ide.js';
import {
  writeAgentsMd,
  writeSkillMd,
  writeQuickstartDoc,
  writeFactoryDroidDroid,
  writeFactoryDroidCommand,
  writeFactoryDroidReliabilityDroid,
  ensureMcpServer,
} from '../lib/skill-writer.js';

// cli-claim-agent is called through the AgentValet proxy (gateway key injected
// server-side). Override with AGENTVALET_API_URL when self-hosting.
const API_URL = process.env.AGENTVALET_API_URL ?? 'https://api.agentvalet.ai';
const CLAIM_URL = `${API_URL}/functions/v1/cli-claim-agent`;

interface ClaimResponse {
  agent_id: string;
  agent_name: string;
  owner_id: string;
  private_key_pem: string;
  proxy_url: string;
}

async function claimToken(installToken: string): Promise<ClaimResponse> {
  const resp = await fetch(CLAIM_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ install_token: installToken }),
  });
  const text = await resp.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep raw text */ }
  if (!resp.ok) {
    const detail = body?.error ?? text ?? `HTTP ${resp.status}`;
    throw new Error(detail);
  }
  if (!body || !body.agent_id || !body.private_key_pem) {
    throw new Error('Server returned an unexpected response');
  }
  return body as ClaimResponse;
}

export function installCommand(): Command {
  return new Command('install')
    .description('Claim an agent created in the dashboard using a one-time install token')
    .argument('<token>', 'install token (itok_...) from the dashboard')
    .option('--no-frameworks', 'skip IDE/framework configuration prompts')
    .option('--project', 'write project-scoped configs (.mcp.json, .cursor/mcp.json) instead of user-scoped (~/.claude.json, ~/.cursor/mcp.json)')
    .action(async (token: string, opts: { frameworks: boolean; project?: boolean }) => {
      const scope: 'user' | 'project' = opts.project ? 'project' : 'user';
      if (!token.startsWith('itok_')) {
        console.error(chalk.red('Invalid install token. Tokens start with "itok_".'));
        process.exit(3);
      }

      console.log(chalk.bold('\n  Claiming agent…'));

      let claim: ClaimResponse;
      try {
        claim = await claimToken(token);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\n  ✗ ${msg}`));
        if (msg.toLowerCase().includes('expired') || msg.toLowerCase().includes('not found')) {
          console.error(chalk.dim('    Generate a fresh install command from app.agentvalet.ai/agents'));
        }
        process.exit(3);
      }

      const { agent_id, agent_name, owner_id, private_key_pem, proxy_url } = claim;

      // Write the private key to ~/.agentvalet/agent.key (matches existing onboard flow)
      try {
        await mkdir(AGENT_DIR, { recursive: true });
        await writeFile(AGENT_KEY_PATH, private_key_pem, { mode: 0o600 });
      } catch (err) {
        console.error(chalk.red(`\n  ✗ Failed to write key: ${err instanceof Error ? err.message : err}`));
        process.exit(3);
      }

      saveConfig({
        agentId: agent_id,
        ownerId: owner_id,
        apiUrl: proxy_url,
        keyPath: AGENT_KEY_PATH,
        proxyUrl: proxy_url,
        lastAgentId: agent_id,
        lastKeyPath: AGENT_KEY_PATH,
      });

      console.log(chalk.green(`  ✓ Agent claimed: ${chalk.bold(agent_name)} (${agent_id})`));
      console.log(chalk.dim(`    Key written to ${AGENT_KEY_PATH}`));

      // Framework configuration — same flow as onboard
      if (opts.frameworks !== false) {
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
            agentId: agent_id,
            ownerId: owner_id,
            proxyUrl: proxy_url,
            keyPath: AGENT_KEY_PATH,
            detected,
            scope,
          });
          for (const r of ideResults) console.log(chalk.green(`  ✓ ${r}`));

          const globalResults = await writeGlobalFrameworkConfigs({
            agentId: agent_id,
            ownerId: owner_id,
            proxyUrl: proxy_url,
            keyPath: AGENT_KEY_PATH,
          });
          for (const r of globalResults) console.log(chalk.green(`  ✓ ${r}`));

          // Project-only artefacts: skill files, droid yaml, quickstart docs.
          // These belong in a specific project, so we only write them when the
          // user explicitly requests project scope. In user scope (the default),
          // the CLI works across every project on this machine without
          // dropping files into whatever cwd the install happens to be in.
          if (scope === 'project') {
            if (detected.codex || detected.codexDesktop) writeAgentsMd();
            if (detected.openclaw) writeSkillMd();
            if (detected.factoryDroid) {
              writeFactoryDroidDroid();
              writeFactoryDroidCommand();
              if (installReliabilityDroid) writeFactoryDroidReliabilityDroid();
            }
            writeQuickstartDoc({
              agentId: agent_id,
              ownerId: owner_id,
              proxyUrl: proxy_url,
              keyPath: AGENT_KEY_PATH,
              detected,
            });
          }

          ensureMcpServer();
        }
      }

      // Write a local .env.agentvalet for non-MCP consumers
      try {
        const envContent = [
          '# AgentValet — generated by agentvalet-register install',
          `AGENTVALET_AGENT_ID=${agent_id}`,
          `AGENTVALET_OWNER_ID=${owner_id}`,
          `AGENTVALET_API_URL=${proxy_url}`,
          `AGENTVALET_PRIVATE_KEY_PATH=${AGENT_KEY_PATH}`,
          '',
        ].join('\n');
        await writeFile(path.join(process.cwd(), '.env.agentvalet'), envContent, { encoding: 'utf8', mode: 0o600 });
      } catch {
        // non-fatal
      }

      console.log('');
      console.log(chalk.bold.green('  ✓ All done!'));
      console.log('');
      console.log(`  Agent ID:  ${chalk.cyan(agent_id)}`);
      console.log(`  Key path:  ${chalk.dim(AGENT_KEY_PATH)}`);
      console.log(`  Proxy:     ${chalk.dim(proxy_url)}`);
      console.log('');

      // Pickup hints — restart vs trust prompt depends on scope.
      if (opts.frameworks !== false) {
        const detected = detectFrameworks();
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
        }
      }

      console.log(`  Dashboard: ${chalk.cyan.underline('https://app.agentvalet.ai/agents/' + agent_id)}`);
      console.log('');
      process.exit(0);
    });
}
