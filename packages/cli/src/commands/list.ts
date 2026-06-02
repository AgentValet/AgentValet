import { Command } from "commander";
import chalk from "chalk";
import { listAgents } from "../lib/api.js";
import { getStoredConfig } from "../config/store.js";
import { tryResolveAgent } from "../lib/require-agent.js";

export function listCommand(): Command {
  return new Command("list")
    .description("List all registered agents")
    .action(async () => {
      const config = getStoredConfig();
      if (!config.cliToken) {
        const creds = tryResolveAgent();
        if (creds) {
          process.stderr.write(
            chalk.red("\n  ✗ CLI session not authenticated.\n") +
            chalk.dim(
              "  An agent is registered (" + creds.agentId + "), but `list` needs an\n" +
              "  authenticated CLI session. Run `npx @agentvalet/register` to sign in,\n" +
              "  or view your agents at:\n\n" +
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

      try {
        const agents = await listAgents();

        if (agents.length === 0) {
          console.log("No agents registered yet. Run: npx @agentvalet/register");
          return;
        }

        const maxNameLen = Math.max(...agents.map((a) => a.name.length), 4);
        const header = `${"ID".padEnd(30)}  ${"NAME".padEnd(maxNameLen)}  STATUS`;
        console.log(header);
        console.log("-".repeat(header.length));
        for (const agent of agents) {
          const status =
            agent.status === "active"
              ? chalk.green("✓ active")
              : agent.status === "suspended"
              ? chalk.yellow("⚠ suspended")
              : chalk.red("✗ revoked");
          console.log(`${agent.id.padEnd(30)}  ${agent.name.padEnd(maxNameLen)}  ${status}`);
        }
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      }
    });
}
