// apps/mcp-server/src/context.ts
//
// The resolved-config + server bundle threaded into auth.ts and the tool
// handlers, so they don't reach for module-level globals (the pattern the
// 963-line index.ts used). Built once in index.ts after validateConfig() and
// server construction. Field names mirror the originals so handler bodies
// moved verbatim.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { validateConfig } from "./config.js";

type ConfigResult = Awaited<ReturnType<typeof validateConfig>>;

export interface ServerContext {
  AGENT_ID: string;
  OWNER_ID: string;
  PROXY_URL: string;
  /** Raw PEM string, or null when no private key is loaded (state B/C). */
  AGENT_PRIVATE_KEY_RAW: string | null;
  /** Imported key object (jose), or null when no key is loaded. */
  privateKey: ConfigResult["privateKey"];
  server: Server;
  /**
   * Observe-mode platform filter. When set (alongside OBSERVE_CREDENTIAL),
   * use_platform routes to the audit-only relay instead of the governed path.
   * Populated from process.env.OBSERVE_PLATFORM; empty string = not configured.
   */
  OBSERVE_PLATFORM: string;
  /**
   * BYO credential for observe mode. Sent as X-AV-Observe-Credential header to
   * the relay endpoint. NEVER passed through model-visible tool args or logged.
   * Populated from process.env.OBSERVE_CREDENTIAL; empty string = not configured.
   */
  OBSERVE_CREDENTIAL: string;
}
