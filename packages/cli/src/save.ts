import { writeFile, mkdir } from "fs/promises";
import { AGENT_DIR, AGENT_KEY_PATH, saveConfig } from "./config/store.js";

interface SaveOptions {
  agentId: string;
  ownerId: string;
  privateKey: string;
  apiUrl: string;
}

interface SaveResult {
  keyPath: string;
}

export async function saveOutput(opts: SaveOptions): Promise<SaveResult> {
  await mkdir(AGENT_DIR, { recursive: true });
  await writeFile(AGENT_KEY_PATH, opts.privateKey, { mode: 0o600 });

  saveConfig({
    agentId: opts.agentId,
    ownerId: opts.ownerId,
    apiUrl: opts.apiUrl,
    keyPath: AGENT_KEY_PATH,
    // keep legacy fields in sync
    lastAgentId: opts.agentId,
    lastKeyPath: AGENT_KEY_PATH,
  });

  return { keyPath: AGENT_KEY_PATH };
}
