import { homedir } from "os";
import { join } from "path";
import { readFile, writeFile, mkdir, access } from "fs/promises";

const CLAUDE_CONFIG_PATH = join(homedir(), ".claude", "config");

interface ClaudeConfig {
  agent_keys?: Record<string, string>;
  [key: string]: unknown;
}

export async function writeKeyToClaudeConfig(agentId: string, privateKeyPem: string): Promise<void> {
  let config: ClaudeConfig = {};

  try {
    await access(CLAUDE_CONFIG_PATH);
    const raw = await readFile(CLAUDE_CONFIG_PATH, "utf-8");
    config = JSON.parse(raw);
  } catch {
    // No existing config — create fresh
  }

  config.agent_keys = config.agent_keys ?? {};
  config.agent_keys[agentId] = Buffer.from(privateKeyPem).toString("base64");

  await mkdir(join(homedir(), ".claude"), { recursive: true });
  await writeFile(CLAUDE_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}
