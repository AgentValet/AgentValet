// packages/client/src/http.ts
//
// Stateless transport helpers. Kept behaviourally identical to the mcp-server's
// net.ts so the SDK and the MCP server fail the same way on the same network
// conditions — an operator debugging one is debugging both.

import { NetworkError } from "./errors.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function fetchWithTimeout(
  doFetch: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  return doFetch(url, { ...init, signal: ac.signal }).finally(() => clearTimeout(timer));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

// Translates a fetch() failure into something a developer can act on. The
// default "fetch failed" tells you nothing about whether it's DNS, a corporate
// MITM proxy, or the proxy being down.
export function diagnoseNetworkError(err: unknown, proxyUrl: string): NetworkError {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  let message: string;
  if (lower.includes("enotfound") || lower.includes("getaddrinfo")) {
    message = `Cannot resolve ${proxyUrl}. Check DNS / corporate proxy / VPN, or confirm proxyUrl is correct. Raw: ${raw}`;
  } else if (lower.includes("econnrefused") || lower.includes("econnreset")) {
    message = `Connection to ${proxyUrl} was refused or reset. The proxy may be down — check https://status.agentvalet.ai — or a firewall is blocking it. Raw: ${raw}`;
  } else if (lower.includes("etimedout") || lower.includes("timeout") || lower.includes("aborterror")) {
    message = `Request to ${proxyUrl} timed out. Likely VPN routing, corporate proxy buffering, or a slow network. Raw: ${raw}`;
  } else if (lower.includes("self signed") || lower.includes("cert") || lower.includes("ssl") || lower.includes("tls")) {
    message = `TLS / certificate problem talking to ${proxyUrl}. A corporate MITM proxy may be intercepting traffic. Raw: ${raw}`;
  } else {
    message = `Network error reaching ${proxyUrl}: ${raw}. Check VPN, corporate proxy, and firewall rules for api.agentvalet.ai.`;
  }
  return new NetworkError(message, err);
}
