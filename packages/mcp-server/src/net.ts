// apps/mcp-server/src/net.ts
//
// Stateless HTTP + MCP-content helpers. No agent identity / config state — see
// auth.ts for the credentialed wrappers. Extracted verbatim from index.ts
// during the modularization (Critique-Roadmap prompt 06.4); behavior unchanged.

export function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 15_000): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  return fetch(url, { ...init, signal: ac.signal }).finally(() => clearTimeout(timer));
}

export function errorContent(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

// Return helper that gives an MCP-aware host the structured content directly
// (no parse step), while still emitting the text-content envelope every MCP
// client understands. Avoids the "list of length 1 with empty fields → let me
// parse the wrapper" round-trip Claude does on tool results that are raw
// JSON strings — every read-heavy use_platform call pays that cost otherwise.
//
// If `body` isn't valid JSON, we just return the text envelope unchanged —
// callers that emit prose (summaries, error strings) get the old behaviour.
export function jsonContent(body: string) {
  const parsed = tryParseJson(body);
  if (parsed === undefined) {
    return { content: [{ type: "text" as const, text: body }] };
  }
  return {
    content: [{ type: "text" as const, text: body }],
    structuredContent: parsed as Record<string, unknown>,
  };
}

export function tryParseJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  // Only attempt parse if it looks structured. Avoids parsing a stray "true"
  // / number / etc. into structuredContent and confusing the host.
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    const v = JSON.parse(trimmed);
    if (v && typeof v === "object") return v;
    return undefined;
  } catch {
    return undefined;
  }
}

export function safeJsonParse(text: string): { approval_id?: string } | null {
  try { return JSON.parse(text); } catch { return null; }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Translates a fetch() failure into something an end-user can actually act on.
// The default "Network error: fetch failed" message tells a non-developer
// nothing. Look at the underlying cause keyword and map to a concrete fix.
export function diagnoseNetworkError(err: unknown, proxyUrl: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  // Node's undici surfaces DNS failures as "getaddrinfo ENOTFOUND <host>".
  if (lower.includes("enotfound") || lower.includes("getaddrinfo")) {
    return `Network error: cannot resolve ${proxyUrl}. Check your DNS / corporate proxy / VPN, or confirm the PROXY_URL setting is correct. Raw: ${raw}`;
  }
  // Connection refused / unreachable / TLS handshake failure.
  if (lower.includes("econnrefused") || lower.includes("econnreset")) {
    return `Network error: connection to ${proxyUrl} was refused or reset. The proxy may be down — check https://status.agentvalet.ai — or a firewall is blocking the request. Raw: ${raw}`;
  }
  if (lower.includes("etimedout") || lower.includes("timeout") || lower.includes("aborterror")) {
    return `Network error: request to ${proxyUrl} timed out. Likely causes: VPN routing, corporate proxy buffering, or slow network. Try again or confirm api.agentvalet.ai is reachable from this machine. Raw: ${raw}`;
  }
  if (lower.includes("self signed") || lower.includes("cert") || lower.includes("ssl") || lower.includes("tls")) {
    return `Network error: TLS / certificate problem talking to ${proxyUrl}. A corporate MITM proxy may be intercepting traffic. Raw: ${raw}`;
  }
  return `Network error reaching ${proxyUrl}: ${raw}. Check VPN, corporate proxy, and firewall rules for api.agentvalet.ai. If the proxy itself is down, see https://status.agentvalet.ai.`;
}
