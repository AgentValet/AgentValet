#!/usr/bin/env node
import { createRequire } from "module";
import { Command } from "commander";
const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };
import chalk from "chalk";
import { runWizard } from "./wizard.js";
import { registerAgent } from "./register.js";
import { waitForApproval } from "./wait.js";
import { saveOutput } from "./save.js";
import { runRefresh, writePermissionsFromEvent } from "./commands/refresh.js";
import { runOnboard } from './commands/onboard.js';
import { listCommand } from './commands/list.js';
import { revokeCommand } from './commands/revoke.js';
import { injectCommand } from './commands/inject.js';
import { uninstallCommand } from './commands/uninstall.js';
import { installCommand } from './commands/install.js';
import { claimCommand } from './commands/claim.js';
import { isAuthenticated, getStoredConfig } from './config/store.js';

function collectScope(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const program = new Command();

program
  .name("agentvalet-register")
  .description("Self-register an AI agent with AgentValet")
  .version(version)
  .option("--owner <uuid>", "Owner ID (or set AGENTVALET_OWNER env var)")
  .option("--name <name>", "Agent name")
  .option("--description <desc>", "Agent description")
  .option("--scope <platform:scope>", "Requested scope, repeatable", collectScope, [])
  .option("--api-url <url>", "AgentValet API base URL", "https://api.agentvalet.ai")
  .option("--json", "Machine-readable JSON output")
  .option("--no-wait", "Register only, do not wait for approval")
  .option("--timeout <seconds>", "Approval wait timeout in seconds", "300")
  .option("--project", "Write project-scoped MCP configs (.mcp.json, .cursor/mcp.json) instead of user-scoped (~/.claude.json, ~/.cursor/mcp.json)")
  .action(async (opts) => {
    const isJson = !!opts.json;

    let ownerId: string = opts.owner ?? process.env.AGENTVALET_OWNER ?? "";
    let agentName: string = opts.name ?? "";
    let description: string = opts.description ?? "";
    let scopes: string[] = opts.scope as string[];

    // New onboarding path: no owner and no stored config
    if (!ownerId && !isAuthenticated()) {
      await runOnboard({ scope: opts.project ? 'project' : 'user', name: agentName || undefined });
      return;
    }

    // Authenticated user without --owner — use the stored ownerId and skip the
    // legacy proxy flow entirely; go through the cli-register-agent path so
    // --name works the same as in the onboard flow.
    if (!ownerId && isAuthenticated()) {
      const stored = getStoredConfig();
      if (stored.ownerId && stored.cliToken) {
        await runOnboard({ scope: opts.project ? 'project' : 'user', name: agentName || undefined });
        return;
      }
    }

    // Run interactive wizard if required fields are missing
    if (!agentName) {
      if (isJson) {
        console.error(JSON.stringify({ error: "--name is required in non-interactive mode" }));
        process.exit(3);
      }
      const answers = await runWizard({ ownerId, agentName, description, scopes });
      ownerId = answers.ownerId;
      agentName = answers.agentName;
      description = answers.description;
      scopes = answers.scopes;
    }

    if (!ownerId) {
      if (isJson) {
        console.error(JSON.stringify({ error: "--owner or AGENTVALET_OWNER is required" }));
        process.exit(3);
      }
      console.error(chalk.red("Error: --owner or AGENTVALET_OWNER environment variable is required"));
      process.exit(3);
    }

    // Group scopes by platform
    const scopeMap = new Map<string, string[]>();
    for (const s of scopes) {
      const colon = s.indexOf(":");
      if (colon === -1) {
        console.error(isJson
          ? JSON.stringify({ error: `Invalid scope format: ${s} (expected platform:scope)` })
          : chalk.red(`Invalid scope format: ${s} (expected platform:scope)`)
        );
        process.exit(3);
      }
      const platform = s.slice(0, colon);
      const scope = s.slice(colon + 1);
      const existing = scopeMap.get(platform) ?? [];
      scopeMap.set(platform, [...existing, scope]);
    }
    const requestedScopes = Array.from(scopeMap.entries()).map(([platformId, s]) => ({
      platformId,
      scopes: s,
    }));

    // Register
    let token: string;
    try {
      token = await registerAgent(opts.apiUrl as string, {
        owner_id: ownerId,
        agent_name: agentName,
        agent_description: description || undefined,
        requested_scopes: requestedScopes,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(isJson ? JSON.stringify({ error: msg }) : chalk.red(`Registration failed: ${msg}`));
      process.exit(3);
    }

    if (!isJson) {
      console.log(chalk.cyan(`\nApprove at: https://app.agentvalet.ai/agents\n`));
    }

    if (!opts.wait) {
      if (isJson) {
        console.log(JSON.stringify({ status: "pending", token }));
      } else {
        console.log(chalk.yellow("Registration submitted (--no-wait). Token:"), token);
      }
      process.exit(0);
    }

    // Wait for approval
    const timeoutMs = parseInt(opts.timeout as string, 10) * 1000;
    let result: Awaited<ReturnType<typeof waitForApproval>>;
    try {
      result = await waitForApproval(opts.apiUrl as string, token, timeoutMs, isJson ? undefined : () => {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(isJson ? JSON.stringify({ error: msg }) : chalk.red(`Wait failed: ${msg}`));
      process.exit(3);
    }

    if (result.status === "rejected") {
      if (isJson) { console.log(JSON.stringify({ status: "rejected" })); }
      else { console.log(chalk.red("\nRegistration denied by owner.")); }
      process.exit(1);
    }

    if (result.status === "timeout" || result.status === "expired") {
      if (isJson) { console.log(JSON.stringify({ status: "timeout" })); }
      else { console.log(chalk.yellow("\nTimed out waiting for approval.")); }
      process.exit(2);
    }

    // Approved
    const { agentId, privateKey, grantedPlatforms } = result as { agentId: string; privateKey: string; grantedPlatforms: import("./wait.js").GrantedPlatform[] };
    const resolvedOwnerId = (result as { ownerId?: string }).ownerId || ownerId;

    let keyPath: string;
    const keyWritten = !!privateKey;

    if (keyWritten) {
      try {
        ({ keyPath } = await saveOutput({
          agentId,
          ownerId: resolvedOwnerId,
          privateKey,
          apiUrl: opts.apiUrl as string,
        }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(isJson ? JSON.stringify({ error: msg }) : chalk.red(`Failed to save output: ${msg}`));
        process.exit(3);
      }
    } else {
      // Key not provided — resolve the default path for display
      const { AGENT_KEY_PATH } = await import("./config/store.js");
      keyPath = AGENT_KEY_PATH;
    }

    if (isJson) {
      console.log(JSON.stringify({ status: "approved", agentId, keyPath: keyWritten ? keyPath : null }));
    } else {
      console.log(chalk.green(`\nApproved! Agent ID: ${agentId}`));
      if (keyWritten) {
        console.log(chalk.gray(`Key:  ${keyPath}`));
      } else {
        console.log(chalk.yellow(`Key:  not written — copy it from the dashboard and paste into ${keyPath}`));
      }
    }

    // Write permissions — use data from SSE event if available, else call the API
    if (keyWritten) {
      try {
        if (grantedPlatforms && grantedPlatforms.length > 0) {
          writePermissionsFromEvent(agentId, resolvedOwnerId, grantedPlatforms);
          if (!isJson) console.log(chalk.gray(`Permissions: .claude/agentvalet-permissions.md`));
        } else {
          await runRefresh({ envFile: ".env.agentvalet", outputPath: ".claude/agentvalet-permissions.md", ifStale: false, quiet: isJson });
          if (!isJson) console.log(chalk.gray(`Permissions: .claude/agentvalet-permissions.md`));
        }
      } catch {
        if (!isJson) console.log(chalk.yellow(`Permissions: run 'agentvalet-register refresh' to generate`));
      }
    }

    process.exit(0);
  });

program
  .command("refresh")
  .description("Refresh approved permissions and update .claude/agentvalet-permissions.md")
  .option("--output <path>", "Path to write permissions file", "./.claude/agentvalet-permissions.md")
  .option("--if-stale", "Skip if file is less than 1 hour old")
  .option("--quiet", "Suppress output")
  .action(async (opts) => {
    try {
      await runRefresh({
        envFile: ".env.agentvalet",
        outputPath: opts.output as string,
        ifStale: !!opts.ifStale,
        quiet: !!opts.quiet,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Refresh failed: ${msg}`));
      process.exit(3);
    }
  });

program
  .command("mcp-server")
  .description("Start the AgentValet MCP server (stdio transport)")
  .action(async () => {
    const { mcpServerCommand } = await import("./commands/mcp-server.js");
    await mcpServerCommand();
  });

program.addCommand(listCommand());
program.addCommand(revokeCommand());
program.addCommand(injectCommand());
program.addCommand(uninstallCommand());
program.addCommand(installCommand());
program.addCommand(claimCommand());

program.parseAsync().catch((err) => {
  console.error(err);
  process.exit(3);
});
