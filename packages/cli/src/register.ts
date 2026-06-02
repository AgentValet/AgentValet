import { fetch } from "undici";

interface RequestedScope {
  platformId: string;
  scopes: string[];
}

interface RegisterBody {
  owner_id: string;
  agent_name: string;
  agent_description?: string;
  requested_scopes: RequestedScope[];
}

export async function registerAgent(apiUrl: string, body: RegisterBody): Promise<string> {
  const res = await fetch(`${apiUrl}/v1/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const wrapped = json.data as Record<string, unknown> | undefined;
    const errMsg = (wrapped?.error ?? json.error ?? `HTTP ${res.status}`) as string;
    throw new Error(errMsg);
  }

  // Response is wrapped: { data: { registration_token: "..." }, _meta: ... }
  const data = (json.data ?? json) as Record<string, unknown>;
  const token = data.registration_token as string | undefined;
  if (!token) throw new Error("No registration_token in response");
  return token;
}
