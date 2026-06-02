import { getStoredConfig } from "../config/store.js";

async function request(path: string, options: { method: string; body?: unknown }): Promise<unknown> {
  const config = getStoredConfig();
  const token = config.cliToken;
  if (!token) {
    throw new Error(
      "Not authenticated.\n" +
      "Run 'npx @agentvalet/register' to register and authenticate."
    );
  }

  const proxyUrl = config.proxyUrl ?? "https://api.agentvalet.ai";
  const response = await fetch(`${proxyUrl}/functions/v1${path}`, {
    method: options.method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }

  return response.json();
}

export async function registerAgent(name: string): Promise<{ agentId: string; cimdUri: string; privateKeyPem: string }> {
  return request("/register-agent", { method: "POST", body: { name } }) as Promise<{ agentId: string; cimdUri: string; privateKeyPem: string }>;
}

export async function revokeAgent(agentId: string): Promise<{ revokedAgentIds: string[] }> {
  return request("/revoke-agent", { method: "POST", body: { agentId } }) as Promise<{ revokedAgentIds: string[] }>;
}

export async function listAgents(): Promise<Array<{ id: string; name: string; status: string; created_at: string }>> {
  return request("/list-agents", { method: "GET" }) as Promise<Array<{ id: string; name: string; status: string; created_at: string }>>;
}
