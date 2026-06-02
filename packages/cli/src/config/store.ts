import Conf from 'conf';
import { homedir } from 'os';
import { join } from 'path';

export const AGENT_DIR      = join(homedir(), '.agentvalet');
export const AGENT_KEY_PATH = join(AGENT_DIR, 'agent.key');

interface CliConfig {
  // Machine-level agent identity (one per machine)
  agentId: string;
  ownerId: string;
  apiUrl: string;
  keyPath: string;
  // Legacy fields — kept for backwards compat reads
  apiKey: string;
  orgId: string;
  proxyUrl: string;
  githubUsername: string;
  email: string;
  cliToken: string;
  lastAgentId: string;
  lastKeyPath: string;
}

const store = new Conf<CliConfig>({
  projectName: 'agentvalet',
  cwd: AGENT_DIR,
  configName: 'config',
});

export function getStoredConfig(): Partial<CliConfig> {
  return store.store;
}

export function saveConfig(config: Partial<CliConfig>): void {
  // Conf rejects `undefined` values — strip them before persisting.
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (v !== undefined) filtered[k] = v;
  }
  store.set(filtered as Partial<CliConfig>);
}

export function clearConfig(): void {
  store.clear();
}

export function isAuthenticated(): boolean {
  return !!store.get('apiKey');
}
