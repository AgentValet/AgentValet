import { Command } from "commander";
import chalk from "chalk";
import { revokeAgent } from "../lib/api.js";
import { getStoredConfig } from "../config/store.js";
import { tryResolveAgent } from "../lib/require-agent.js";
import { cleanLocally } from "./uninstall.js";
import * as readline from "readline";

export function revokeCommand(): Command {
  return new Command("revoke")
    .description("Revoke an agent (cascades to all child agents) and clean local config")
    .requiredOption("--agent-id <agentId>", "Agent ID to revoke (agt_...)")
    .option("--keep-local", "Skip cleaning local MCP configs and key files after revoke")
    .action(async (opts) => {
      const config = getStoredConfig();
      if (!config.cliToken) {
        const creds = tryResolveAgent();
        if (creds) {
          process.stderr.write(
            chalk.red("\n  ✗ CLI session not authenticated.\n") +
            chalk.dim(
              "  An agent is registered (" + creds.agentId + "), but `revoke` needs an\n" +
              "  authenticated CLI session. Run `npx @agentvalet/register` to sign in,\n" +
              "  or revoke from the dashboard:\n\n" +
              "    " + creds.apiUrl.replace("api.", "app.") + "/agents\n\n"
            )
          );
        } else {
          process.stderr.write(
            chalk.red("\n  ✗ No agent registered.\n") +
            chalk.dim("  Run the following command first:\n\n    npx @agentvalet/register\n\n")
          );
        }
        process.exit(1);
      }

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const confirmed = await new Promise<boolean>((resolve) => {
        rl.question(
          chalk.yellow(`Revoke ${opts.agentId}? This cascades to all child agents and cannot be undone. (y/N) `),
          (ans) => { rl.close(); resolve(ans.trim().toLowerCase() === "y"); }
        );
      });

      if (!confirmed) {
        console.log("Cancelled.");
        return;
      }

      let revokedAgentIds: string[] = [];
      try {
        const result = await revokeAgent(opts.agentId);
        revokedAgentIds = result.revokedAgentIds;
        console.log(chalk.green(`Revoked ${revokedAgentIds.length} agent(s)`));
        if (revokedAgentIds.length > 1) {
          console.log("Revoked:", revokedAgentIds.join(", "));
        }
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      }

      // Clean local MCP entries and key material if the agent installed on
      // this machine was in the revoked set (covers cascaded child revokes).
      // Skipped with --keep-local.
      if (!opts.keepLocal) {
        const creds = tryResolveAgent();
        if (creds && revokedAgentIds.includes(creds.agentId)) {
          console.log("");
          console.log(chalk.dim("  Cleaning local config for revoked agent..."));
          cleanLocally();
        }
      }
    });
}
