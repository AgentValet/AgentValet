import { Command } from "commander";
import chalk from "chalk";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname } from "path";
import { writeKeyToClaudeConfig } from "../lib/claude-config.js";
import { writeKeyToEnvLocal } from "../lib/env-writer.js";
import { AGENT_KEY_PATH, AGENT_DIR, saveConfig } from "../config/store.js";
import { detectFrameworks, frameworkSetupConsent } from "../config/frameworks.js";
import { writeIdeConfigs, writeGlobalFrameworkConfigs } from "../config/ide.js";

type InjectTarget = "agentvalet" | "env-local" | "claude-legacy" | "claude-code";

export function injectCommand(): Command {
  return new Command("inject")
    .description("Import an existing PEM private key for an agent into the local store + framework configs")
    .requiredOption("--agent-id <agentId>", "Agent ID (agt_...)")
    .requiredOption("--key-file <path>", "Path to the private key PEM file")
    .option("--owner-id <ownerId>", "Owner ID (required for --target agentvalet so the MCP server can authenticate)")
    .option("--proxy-url <url>", "Proxy base URL", "https://api.agentvalet.ai")
    .option(
      "--target <target>",
      "Where to write the key: agentvalet (default — modern store + MCP configs), env-local (.env.local), claude-legacy (~/.claude/config, deprecated)",
      "agentvalet",
    )
    .option("--no-frameworks", "Skip IDE/framework configuration prompts (only with --target agentvalet)")
    .option("--project", "Write project-scoped framework configs instead of user-scoped")
    .action(async (opts: {
      agentId: string;
      keyFile: string;
      ownerId?: string;
      proxyUrl: string;
      target: InjectTarget;
      frameworks: boolean;
      project?: boolean;
    }) => {
      let privateKeyPem: string;
      try {
        privateKeyPem = await readFile(opts.keyFile, "utf-8");
      } catch {
        console.error(chalk.red(`Could not read key file: ${opts.keyFile}`));
        process.exit(1);
      }

      if (!privateKeyPem.includes("BEGIN PRIVATE KEY")) {
        console.error(chalk.red("File does not appear to be a PEM private key"));
        process.exit(1);
      }

      // `claude-code` was the old default target name and is kept as an alias
      // for `claude-legacy` so existing scripts don't break.
      const target = opts.target === "claude-code" ? "claude-legacy" : opts.target;

      try {
        if (target === "agentvalet") {
          if (!opts.ownerId) {
            console.error(chalk.red("--owner-id is required when target is 'agentvalet' (the MCP server needs it to authenticate)"));
            console.error(chalk.dim("  Find it at https://app.agentvalet.ai or in your existing ~/.agentvalet/config.json"));
            process.exit(1);
          }

          // Write the key to the modern store: ~/.agentvalet/agent.key
          await mkdir(dirname(AGENT_KEY_PATH), { recursive: true });
          await writeFile(AGENT_KEY_PATH, privateKeyPem, { mode: 0o600 });

          // Save agent identity in the canonical config so all CLI commands
          // (refresh, uninstall, mcp-server, etc.) can resolve credentials.
          saveConfig({
            agentId: opts.agentId,
            ownerId: opts.ownerId,
            apiUrl: opts.proxyUrl,
            proxyUrl: opts.proxyUrl,
            keyPath: AGENT_KEY_PATH,
            lastAgentId: opts.agentId,
            lastKeyPath: AGENT_KEY_PATH,
          });

          console.log(chalk.green(`  ✓ Key imported → ${AGENT_KEY_PATH}`));
          console.log(chalk.green(`  ✓ Agent ID saved to ~/.agentvalet/config.json`));

          if (opts.frameworks !== false) {
            const detected = detectFrameworks();
            const shouldSetup = await frameworkSetupConsent(detected);
            if (shouldSetup) {
              console.log("");
              console.log(chalk.bold("  Configuring agent frameworks..."));
              console.log("");

              const ideResults = await writeIdeConfigs({
                agentId: opts.agentId,
                ownerId: opts.ownerId,
                proxyUrl: opts.proxyUrl,
                keyPath: AGENT_KEY_PATH,
                detected,
                scope: opts.project ? "project" : "user",
              });
              for (const r of ideResults) console.log(chalk.green(`  ✓ ${r}`));

              const globalResults = await writeGlobalFrameworkConfigs({
                agentId: opts.agentId,
                ownerId: opts.ownerId,
                proxyUrl: opts.proxyUrl,
                keyPath: AGENT_KEY_PATH,
              });
              for (const r of globalResults) console.log(chalk.green(`  ✓ ${r}`));
            }
          }

          console.log("");
          console.log(chalk.dim(`  ${AGENT_DIR}/ is excluded from git by convention — do not commit it.`));
        } else if (target === "env-local") {
          await writeKeyToEnvLocal(opts.agentId, privateKeyPem);
          console.log(chalk.green("  ✓ Key appended to .env.local"));
          console.log(chalk.dim("  Add .env.local to .gitignore — do not commit private keys to git."));
        } else if (target === "claude-legacy") {
          console.warn(chalk.yellow("  ⚠ --target claude-legacy is deprecated."));
          console.warn(chalk.dim("    Modern Claude Code reads MCP configs from ~/.claude.json, not ~/.claude/config."));
          console.warn(chalk.dim("    Use --target agentvalet (default) instead."));
          await writeKeyToClaudeConfig(opts.agentId, privateKeyPem);
          console.log(chalk.green("  ✓ Key written to ~/.claude/config (legacy location)"));
        } else {
          console.error(chalk.red(`Unknown target: ${opts.target}. Use 'agentvalet', 'env-local', or 'claude-legacy'.`));
          process.exit(1);
        }
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      }

      console.log(chalk.green("\n  Done. Your agent is ready to use."));
    });
}
