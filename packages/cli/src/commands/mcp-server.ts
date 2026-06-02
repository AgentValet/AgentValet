import { spawn } from "child_process";
import { createRequire } from "module";

// Resolve the canonical @agentvalet/mcp-server binary from the installed package.
// In the monorepo this resolves to apps/mcp-server/dist/index.js (workspace link).
// When published, it resolves to the installed npm package.
function resolveMcpServerBin(): string {
  try {
    const require = createRequire(import.meta.url);
    return require.resolve("@agentvalet/mcp-server/dist/index.js");
  } catch {
    // Fallback: try resolving the package root and appending the known bin path
    try {
      const require = createRequire(import.meta.url);
      const pkgRoot = require.resolve("@agentvalet/mcp-server/package.json");
      return pkgRoot.replace("package.json", "dist/index.js");
    } catch {
      throw new Error(
        "@agentvalet/mcp-server is not installed. Run: npx @agentvalet/register"
      );
    }
  }
}

export async function mcpServerCommand(): Promise<void> {
  let binPath: string;
  try {
    binPath = resolveMcpServerBin();
  } catch (err) {
    process.stderr.write(
      `[agentvalet] ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  }

  // Delegate entirely to the canonical MCP server.
  // All required env vars (AGENT_ID, OWNER_ID, PROXY_URL, AGENT_PRIVATE_KEY / AGENT_PRIVATE_KEY_PATH)
  // must be set before this command is called — they come from .mcp.json or the shell.
  const child = spawn(process.execPath, [binPath], {
    stdio: "inherit",
    env: process.env,
  });

  child.on("error", (err) => {
    process.stderr.write(`[agentvalet] Failed to start MCP server: ${err.message}\n`);
    process.exit(1);
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}
