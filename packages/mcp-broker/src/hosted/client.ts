// Shared plumbing for the hosted (agentvalet:) sources. Every hosted source
// talks to the AgentValet control plane over HTTPS, base-URLed to
// https://api.agentvalet.ai and overridable with AGENTVALET_API_URL. Auth is a
// bearer token (the server author's AgentValet agent token) read from
// AGENTVALET_TOKEN by default, or supplied directly. fetch is injectable so the
// sources are testable without a network.
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text?(): Promise<string> }>;

export type TokenProvider = string | (() => string | Promise<string>);

export interface HostedOptions {
  apiUrl?: string;
  token?: TokenProvider;
  fetch?: FetchLike;
  // The AgentValet agent id used as the AuthZEN subject. If omitted it is read
  // from the token's agent_id claim.
  agentId?: string;
}

export const DEFAULT_API_URL = "https://api.agentvalet.ai";

function envVar(name: string): string | undefined {
  return typeof process !== "undefined" && process.env ? process.env[name] : undefined;
}

export function resolveApiUrl(explicit?: string): string {
  return (explicit ?? envVar("AGENTVALET_API_URL") ?? DEFAULT_API_URL).replace(/\/+$/, "");
}

// Best-effort agent id from a JWT's payload, without verifying the signature
// (verification is the server's job). Returns undefined if the token is not a
// three-segment JWT or has no agent_id claim.
export function agentIdFromToken(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const json = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { agent_id?: unknown };
    return typeof json.agent_id === "string" ? json.agent_id : undefined;
  } catch {
    return undefined;
  }
}

export class HostedClient {
  readonly baseUrl: string;
  private readonly token: TokenProvider;
  private readonly fetchImpl: FetchLike;

  constructor(opts: HostedOptions) {
    this.baseUrl = resolveApiUrl(opts.apiUrl);
    const token = opts.token ?? envVar("AGENTVALET_TOKEN");
    if (!token) {
      throw new Error(
        "hosted source requires an AgentValet token (set AGENTVALET_TOKEN or pass { token })",
      );
    }
    this.token = token;
    const f = opts.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!f) throw new Error("hosted source requires a fetch implementation (Node >=18 or an injected fetch)");
    this.fetchImpl = f;
  }

  private async bearer(): Promise<string> {
    return typeof this.token === "function" ? await this.token() : this.token;
  }

  // The AgentValet agent id to use as an AuthZEN subject: an explicit override,
  // else the agent_id claim on the bearer token.
  async subjectId(explicit?: string): Promise<string> {
    if (explicit) return explicit;
    const derived = agentIdFromToken(await this.bearer());
    if (!derived) {
      throw new Error("could not determine AgentValet agent id (pass { agentId } or use an agent JWT)");
    }
    return derived;
  }

  async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.bearer()}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      throw new HostedHttpError(`${method} ${path} -> HTTP ${res.status}`, res.status);
    }
    return res.json();
  }
}

export class HostedHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "HostedHttpError";
  }
}
