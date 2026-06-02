import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';

export async function writeLocalConfig(config: {
  agentId: string;
  agentName: string;
  proxyUrl: string;
  privateKeyPem: string;
}) {
  const dir = path.join(process.cwd(), '.agentvalet');
  await mkdir(dir, { recursive: true });

  await writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({
      agent_id: config.agentId,
      agent_name: config.agentName,
      proxy_url: config.proxyUrl,
      registered_at: new Date().toISOString(),
    }, null, 2),
    { encoding: 'utf8', mode: 0o600 }
  );

  await writeFile(
    path.join(dir, 'agent.key'),
    config.privateKeyPem,
    { encoding: 'utf8', mode: 0o600 }
  );
  if (process.platform === 'win32') {
    console.warn('  Note: file permissions (0o600) are not enforced on Windows. Keep .agentvalet/ in a secure location.');
  }

  const gitignorePath = path.join(process.cwd(), '.gitignore');
  const gitignoreContent = await readFile(gitignorePath, 'utf8').catch(() => null);
  if (gitignoreContent !== null) {
    const lines = gitignoreContent.split('\n').map(l => l.trim());
    if (!lines.includes('.agentvalet/')) {
      await appendFile(gitignorePath, '\n# AgentValet\n.agentvalet/\n');
    }
  }
}
