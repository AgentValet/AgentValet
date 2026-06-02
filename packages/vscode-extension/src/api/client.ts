import * as vscode from 'vscode';

function getApiUrl(): string {
  return vscode.workspace
    .getConfiguration('agentvalet')
    .get('apiUrl', 'https://api.agentvalet.ai');
}

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 10_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new Error('Request timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface CreateAccountResult {
  owner_id: string;
  org_id: string;
  proxy_url: string;
  is_new_account: boolean;
}

export async function createOrFindAccount(params: {
  github_token: string;
  github_username: string;
  email: string;
  display_name: string;
}): Promise<CreateAccountResult> {
  const response = await fetchWithTimeout(`${getApiUrl()}/v1/cli/account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(`Account setup failed: ${response.status} ${err.message ?? ''}`);
  }
  return response.json();
}

export interface RegisterAgentResult {
  agent_id: string;
  agent_name: string;
  private_key_pem: string;
}

export async function registerAgent(params: {
  owner_id: string;
  name: string;
  source: 'vscode';
  description?: string;
}, apiKey: string): Promise<RegisterAgentResult> {
  const response = await fetchWithTimeout(`${getApiUrl()}/v1/cli/register-agent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(`Agent registration failed: ${response.status} ${err.message ?? ''}`);
  }
  return response.json();
}

export function detectEditor(): string {
  const appName = vscode.env.appName.toLowerCase();
  if (appName.includes('cursor')) return 'cursor';
  if (appName.includes('windsurf')) return 'windsurf';
  if (appName.includes('gitpod')) return 'gitpod';
  return 'vscode';
}
