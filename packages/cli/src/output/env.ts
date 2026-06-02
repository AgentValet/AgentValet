import chalk from 'chalk';
import { appendFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export function formatEnvBlock(vars: Record<string, string>): string {
  return Object.entries(vars).map(([key, value]) => {
    const truncated = value.length > 60
      ? value.substring(0, 40) + '...' + value.substring(value.length - 10)
      : value;
    return `  ${chalk.dim(key + '=')}${chalk.white(truncated)}`;
  }).join('\n');
}

export async function writeEnvBlock(
  vars: Record<string, string>
): Promise<void> {
  const envPath = path.join(process.cwd(), '.env');
  const lines = Object.entries(vars)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const content = `\n# AgentValet\n${lines}\n`;

  if (existsSync(envPath)) {
    await appendFile(envPath, content);
  } else {
    await writeFile(envPath, content.trimStart(), { encoding: 'utf8', mode: 0o600 });
  }
}
