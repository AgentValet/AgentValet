// All onboarding calls route through the AgentValet proxy, which forwards to the
// backing edge functions and injects the gateway key server-side. Override with
// AGENTVALET_API_URL when self-hosting.
const API_URL = process.env.AGENTVALET_API_URL ?? 'https://api.agentvalet.ai';
const FUNCTIONS_URL = `${API_URL}/functions/v1`;

const baseHeaders = {
  'Content-Type': 'application/json',
};

export interface CreateAccountResult {
  owner_id: string;
  org_id: string;
  proxy_url: string;
  is_new_account: boolean;
  cli_token: string;
}

export interface RegisterAgentResult {
  agent_id: string;
  agent_name: string;
  private_key_pem: string;
  public_key_pem: string;
}

export async function createOrFindAccount(params: {
  github_token: string;
  github_username: string;
  email: string;
  display_name: string;
  avatar_url: string;
}): Promise<CreateAccountResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${FUNCTIONS_URL}/cli-account`, {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify(params),
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(`Account setup failed: ${response.status} ${error.error ?? ''}`);
    }
    return response.json() as Promise<CreateAccountResult>;
  } catch (err: any) {
    clearTimeout(timeout);
    if (err?.name === 'AbortError') throw new Error('Request timed out — is the AgentValet API reachable?');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export async function registerAgent(params: {
  owner_id: string;
  name: string;
  description?: string;
  source: 'cli';
  agent_type?: string;
}, apiKey: string): Promise<RegisterAgentResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${FUNCTIONS_URL}/cli-register-agent`, {
      method: 'POST',
      headers: {
        ...baseHeaders,
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(params),
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { error?: string; detail?: string };
      const detail = error.detail ? ` — ${error.detail}` : '';
      throw new Error(`Agent registration failed: ${response.status} ${error.error ?? ''}${detail}`);
    }
    return response.json() as Promise<RegisterAgentResult>;
  } catch (err: any) {
    clearTimeout(timeout);
    if (err?.name === 'AbortError') throw new Error('Request timed out — is the AgentValet API reachable?');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getAccount(apiKey: string): Promise<{
  owner_id: string;
  org_id: string;
  email: string;
  plan: string;
  cli_token: string;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${FUNCTIONS_URL}/cli-account`, {
      headers: {
        ...baseHeaders,
        'Authorization': `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(`Failed to fetch account: ${response.status} ${error.error ?? ''}`);
    }
    return response.json() as Promise<{ owner_id: string; org_id: string; email: string; plan: string; cli_token: string; }>;
  } catch (err: any) {
    clearTimeout(timeout);
    if (err?.name === 'AbortError') throw new Error('Request timed out — is the AgentValet API reachable?');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
