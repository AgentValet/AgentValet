import type { AdapterTestResult } from "../types/paperclip.js";
import { readPemFromEnv, CompanyKeyError } from "./pem.js";

export async function testEnvironment(
  config: Record<string, unknown>
): Promise<AdapterTestResult[]> {
  const results: AdapterTestResult[] = [];

  const proxyUrl = (process.env.AGENTVALET_PROXY_URL ?? "").replace(/\/$/, "");
  const ownerId = process.env.AGENTVALET_OWNER_ID ?? "";

  if (!proxyUrl) {
    results.push({ level: "error", message: "AGENTVALET_PROXY_URL is not set. Add it to your Paperclip instance environment variables." });
  } else {
    results.push({ level: "info", message: `Proxy URL: ${proxyUrl}` });
  }

  if (!ownerId) {
    results.push({ level: "error", message: "AGENTVALET_OWNER_ID is not set. Find your Owner ID in AgentValet → Settings." });
  } else {
    results.push({ level: "info", message: `Owner ID: ${ownerId}` });
  }

  try {
    const pem = readPemFromEnv('AGENTVALET_COMPANY_KEY');

    const { importPKCS8 } = await import('jose');
    await importPKCS8(pem, 'RS256');

    results.push({ level: 'info', message: 'Company key: valid RS256 private key found and verified ✓' });
  } catch (err) {
    if (err instanceof CompanyKeyError) {
      results.push({ level: 'error', message: err.message });
    } else {
      results.push({
        level: 'error',
        message:
          `AGENTVALET_COMPANY_KEY is set but could not be imported as RS256: ` +
          `${(err as Error).message}\n` +
          `Ensure it is an RSA-2048 private key in PKCS8 or traditional PEM format.`,
      });
    }
  }

  if (proxyUrl) {
    try {
      const resp = await fetch(`${proxyUrl}/health`, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        results.push({ level: "info", message: `AgentValet reachable at ${proxyUrl} ✓` });
      } else {
        results.push({ level: "warn", message: `AgentValet returned ${resp.status} at ${proxyUrl}/health` });
      }
    } catch (err) {
      results.push({ level: "error", message: `Cannot reach AgentValet at ${proxyUrl}: ${(err as Error).message}` });
    }
  }

  const underlyingAdapter = (config.underlyingAdapter as string | undefined) ?? "claude_local";
  const validUnderlying = ["claude_local", "process", "http"];
  if (!validUnderlying.includes(underlyingAdapter)) {
    results.push({ level: "warn", message: `underlyingAdapter "${underlyingAdapter}" is not a known option. Valid: ${validUnderlying.join(", ")}` });
  } else {
    results.push({ level: "info", message: `Underlying adapter: ${underlyingAdapter}` });
  }

  const scopes = config.agentvaletScopes;
  if (scopes !== undefined) {
    if (!Array.isArray(scopes)) {
      results.push({ level: "warn", message: 'agentvaletScopes must be an array of strings e.g. ["slack:read", "stripe:read"]. Ignoring.' });
    } else if (scopes.length > 0) {
      results.push({ level: "info", message: `Scope hints: ${(scopes as string[]).join(", ")} (hint only — owner sets final permissions in AgentValet dashboard)` });
    }
  }

  if (config.agentvaletAgentId !== undefined || config.agentvaletPrivateKeyEnv !== undefined) {
    results.push({ level: "warn", message: "agentvaletAgentId and agentvaletPrivateKeyEnv are no longer used. The adapter now uses company-level env vars (AGENTVALET_COMPANY_KEY, AGENTVALET_OWNER_ID) and auto-registers agents on first heartbeat. Remove these fields from adapterConfig." });
  }

  return results;
}
