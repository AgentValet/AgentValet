import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs";
import { dirname, resolve } from "path";
import { signJwt } from "../lib/jwt.js";
import { generatePermissionsFile } from "../lib/skill-writer.js";
import { tryResolveAgent } from "../lib/require-agent.js";
import { detectFrameworks } from "../config/frameworks.js";
import type { GrantedPlatform } from "../wait.js";

const PERMISSIONS_START = "<!-- agentvalet:permissions:start -->";
const PERMISSIONS_END = "<!-- agentvalet:permissions:end -->";

const CLAUDE_START = "<!-- agentvalet:start -->";
const CLAUDE_END = "<!-- agentvalet:end -->";
const HOOK_COMMAND = "npx @agentvalet/register refresh --if-stale --quiet 2>/dev/null || true";
const HOOK_MARKER = "agentvalet/register refresh";

interface RefreshOptions {
  envFile: string;
  outputPath: string;
  ifStale: boolean;
  quiet: boolean;
}


export function writePermissionsFromEvent(
  agentId: string,
  ownerId: string,
  platforms: GrantedPlatform[],
  outputPath = "./.claude/agentvalet-permissions.md"
): void {
  const content = generatePermissionsFile(agentId, ownerId, platforms);
  const resolvedPath = resolve(outputPath);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, content, "utf-8");
  embedInClaudeMd(content);
  ensureHook();
}

export async function runRefresh(options: RefreshOptions): Promise<void> {
  const outputPath = resolve(options.outputPath);

  // Skip only if file is fresh, CLAUDE.md has the embedded block, and block has platforms
  if (options.ifStale) {
    try {
      const stat = statSync(outputPath);
      const fileIsFresh = Date.now() - stat.mtimeMs < 3_600_000;
      const claudeMdPath = resolve("CLAUDE.md");
      const claudeMd = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf-8") : "";
      const blockStart = claudeMd.indexOf(CLAUDE_START);
      const blockEnd = claudeMd.indexOf(CLAUDE_END);
      const blockContent = blockStart !== -1 && blockEnd !== -1
        ? claudeMd.slice(blockStart, blockEnd)
        : "";
      const blockHasPlatforms = blockContent.includes("### ");
      if (fileIsFresh && blockHasPlatforms) return;
    } catch {
      // proceed
    }
  }

  const creds = tryResolveAgent(options.envFile);
  if (!creds || !existsSync(resolve(creds.keyPath))) {
    console.error("  ✗ No agent registered.\n  Run the following command first to register an agent in this directory:\n\n    npx @agentvalet/register\n");
    process.exit(1);
  }
  const { agentId, ownerId, keyPath, apiUrl } = creds;

  let privateKeyPem: string;
  try {
    privateKeyPem = readFileSync(keyPath, "utf-8");
  } catch {
    throw new Error(`Cannot read private key: ${keyPath}`);
  }

  if (!privateKeyPem.trim()) {
    throw new Error(`Private key file is empty: ${keyPath}`);
  }

  const jwt = signJwt(agentId, ownerId, privateKeyPem);

  const res = await fetch(`${apiUrl}/v1/agent/permissions`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Permissions API returned ${res.status}: ${body}`);
  }

  const json = (await res.json()) as { data?: { platforms?: unknown[] } };
  const platforms = (json.data?.platforms ?? []) as Array<{
    platformId: string;
    platformName: string;
    scopes: string[];
    requireApproval: boolean;
  }>;

  const content = generatePermissionsFile(agentId, ownerId, platforms);

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content, "utf-8");

  embedInClaudeMd(content);
  ensureHook();

  // Refresh permission blocks for other detected frameworks too. These are
  // best-effort — if a framework isn't installed or a doc doesn't exist we
  // skip it silently.
  const detected = detectFrameworks();
  const refreshed: string[] = [];
  if (detected.codex || detected.codexDesktop) {
    if (embedPermissionsBlock(resolve("AGENTS.md"), content)) refreshed.push("AGENTS.md");
  }
  if (detected.openclaw) {
    if (embedPermissionsBlock(resolve("SKILL.md"), content)) refreshed.push("SKILL.md");
  }

  if (!options.quiet) {
    const extras = refreshed.length > 0 ? ` (also: ${refreshed.join(", ")})` : "";
    console.log(`Permissions refreshed → ${outputPath} (${platforms.length} platform${platforms.length !== 1 ? "s" : ""})${extras}`);
  }
}

// Embed (or replace) a permissions block inside an existing skill/agents doc.
// Uses framework-neutral marker comments so it never collides with the
// Claude-specific <!-- agentvalet:start --> markers used in CLAUDE.md.
// Returns true if the file existed and was updated.
function embedPermissionsBlock(filePath: string, permissionsContent: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    const existing = readFileSync(filePath, "utf-8");
    const block = `${PERMISSIONS_START}\n${permissionsContent.trimEnd()}\n${PERMISSIONS_END}`;
    let next: string;
    if (existing.includes(PERMISSIONS_START)) {
      next = existing.replace(
        new RegExp(`${PERMISSIONS_START}[\\s\\S]*?${PERMISSIONS_END}`, "m"),
        block
      );
    } else {
      next = `${existing.trimEnd()}\n\n${block}\n`;
    }
    writeFileSync(filePath, next, "utf-8");
    return true;
  } catch {
    return false;
  }
}

function embedInClaudeMd(permissionsContent: string): void {
  const claudeMdPath = resolve("CLAUDE.md");
  const block = `${CLAUDE_START}\n${permissionsContent.trimEnd()}\n${CLAUDE_END}`;

  if (!existsSync(claudeMdPath)) {
    writeFileSync(claudeMdPath, `# Agent Instructions\n\n${block}\n`, "utf-8");
    return;
  }

  const existing = readFileSync(claudeMdPath, "utf-8");
  if (existing.includes(CLAUDE_START)) {
    // Replace existing block
    const replaced = existing.replace(
      new RegExp(`${CLAUDE_START}[\\s\\S]*?${CLAUDE_END}`, "m"),
      block
    );
    writeFileSync(claudeMdPath, replaced, "utf-8");
  } else {
    // Remove stale @-import line if present, then append block
    const cleaned = existing.replace(/^@\.claude\/agentvalet-permissions\.md\s*$/m, "").trimEnd();
    writeFileSync(claudeMdPath, `${cleaned}\n\n${block}\n`, "utf-8");
  }
}

function ensureHook(): void {
  const settingsPath = resolve(".claude/settings.local.json");

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    } catch {
      // unparseable — leave existing file alone
      return;
    }
  }

  // Ensure UserPromptSubmit hook
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const ups = (hooks.UserPromptSubmit ?? []) as Array<{ hooks?: Array<{ command?: string }> }>;
  const hookAlreadyWired = ups.some((entry) =>
    entry.hooks?.some((h) => h.command?.includes(HOOK_MARKER))
  );
  if (!hookAlreadyWired) {
    const newEntry = { matcher: "", hooks: [{ type: "command", command: HOOK_COMMAND }] };
    settings.hooks = { ...hooks, UserPromptSubmit: [...ups, newEntry] };
  }

  // Ensure allow-list entries for MCP tools
  const perms = (settings.permissions ?? {}) as Record<string, unknown>;
  const allow = (perms.allow ?? []) as string[];
  const mcpAllows = ["mcp__agentvalet__list_platforms", "mcp__agentvalet__use_platform"];
  const missing = mcpAllows.filter((e) => !allow.includes(e));
  if (missing.length > 0) {
    perms.allow = [...allow, ...missing];
    settings.permissions = perms;
  }

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");

  // Write .mcp.json at project root (Claude Code reads MCP servers from here, not settings.local.json)
  ensureMcpJson();
}

function ensureMcpJson(): void {
  const mcpJsonPath = resolve(".mcp.json");

  let mcpConfig: Record<string, unknown> = {};
  if (existsSync(mcpJsonPath)) {
    try {
      mcpConfig = JSON.parse(readFileSync(mcpJsonPath, "utf-8")) as Record<string, unknown>;
    } catch {
      return; // unparseable — leave alone
    }
  }

  const servers = (mcpConfig.mcpServers ?? {}) as Record<string, unknown>;
  if (servers["agentvalet"]) return; // already wired

  const creds = tryResolveAgent();
  if (!creds) return;

  const { agentId, ownerId, apiUrl, keyPath } = creds;

  servers["agentvalet"] = {
    command: "npx",
    args: ["-y", "@agentvalet/register", "mcp-server"],
    env: {
      AGENT_ID: agentId,
      OWNER_ID: ownerId,
      PROXY_URL: apiUrl,
      AGENT_PRIVATE_KEY_PATH: keyPath,
    },
  };
  mcpConfig.mcpServers = servers;
  writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + "\n", "utf-8");
}
