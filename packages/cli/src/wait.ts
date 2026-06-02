import { fetch } from "undici";

export interface GrantedPlatform {
  platformId: string;
  platformName: string;
  scopes: string[];
  requireApproval: boolean;
}

export type WaitResult =
  | { status: "approved"; agentId: string; ownerId: string; privateKey: string; grantedPlatforms: GrantedPlatform[] }
  | { status: "rejected" }
  | { status: "timeout" }
  | { status: "expired" };

export async function waitForApproval(
  apiUrl: string,
  token: string,
  timeoutMs: number,
  onTick?: () => void
): Promise<WaitResult> {
  const deadline = Date.now() + timeoutMs;

  const sseResult = await trySSE(apiUrl, token, timeoutMs, onTick);
  if (sseResult) return enrichWithKey(apiUrl, token, sseResult);

  const pollResult = await poll(apiUrl, token, deadline, onTick);
  return enrichWithKey(apiUrl, token, pollResult);
}

async function enrichWithKey(apiUrl: string, token: string, result: WaitResult): Promise<WaitResult> {
  if (result.status !== "approved") return result;
  try {
    const res = await fetch(`${apiUrl}/v1/register/claim-key/${token}`);
    if (!res.ok) return result;
    const json = (await res.json()) as { private_key?: string };
    return { ...result, privateKey: json.private_key ?? "" };
  } catch {
    return result;
  }
}

async function trySSE(
  apiUrl: string,
  token: string,
  windowMs: number,
  onTick?: () => void
): Promise<WaitResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), windowMs);

  try {
    const res = await fetch(`${apiUrl}/v1/register/stream/${token}`, {
      signal: controller.signal,
      headers: { Accept: "text/event-stream" },
    });

    if (!res.ok || !res.body) return null;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith(":")) { onTick?.(); continue; }
        if (line.startsWith("data:")) {
          const dataStr = line.slice(5).trim();
          if (!dataStr) continue;
          try {
            const data = JSON.parse(dataStr) as Record<string, unknown>;
            const parsed = parseEvent(data);
            if (parsed) return parsed;
          } catch { /* ignore */ }
        }
      }
    }

    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function poll(
  apiUrl: string,
  token: string,
  deadline: number,
  onTick?: () => void
): Promise<WaitResult> {
  while (Date.now() < deadline) {
    await sleep(5_000);
    onTick?.();
    try {
      const res = await fetch(`${apiUrl}/v1/register/status/${token}`);
      if (!res.ok) continue;
      const json = (await res.json()) as Record<string, unknown>;
      const data = (json.data ?? json) as Record<string, unknown>;
      const parsed = parseEvent(data);
      if (parsed) return parsed;
    } catch { /* retry */ }
  }
  return { status: "timeout" };
}

function parseEvent(data: Record<string, unknown>): WaitResult | null {
  if (data.status === "approved") {
    const agentId = (data.agent_id ?? data.agentId) as string | undefined;
    if (!agentId) return null;
    const ownerId = (data.owner_id ?? data.ownerId ?? "") as string;
    const grantedPlatforms = (data.granted_platforms ?? []) as GrantedPlatform[];
    return { status: "approved", agentId, ownerId, privateKey: "", grantedPlatforms };
  }
  if (data.status === "rejected") return { status: "rejected" };
  if (data.status === "timeout" || data.status === "expired") return { status: "expired" };
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
