// Default identity resolver: derive the caller's identity from the MCP session.
// With an authenticated transport it also picks up the DCR client id and, if the
// token carries one, a SPIFFE id. A server author who needs something else
// passes their own IdentityResolver.
import type { IdentityResolver, McpHandlerExtra, AccessRequest } from "./types.js";

function readSpiffe(extra: McpHandlerExtra): string | undefined {
  const s = extra.authInfo?.extra?.["spiffeId"];
  return typeof s === "string" ? s : undefined;
}

export const defaultIdentityResolver: IdentityResolver = {
  resolve(extra: McpHandlerExtra): AccessRequest["subject"] {
    const sessionId = extra.sessionId ?? (extra.requestId != null ? String(extra.requestId) : "no-session");
    const id = extra.authInfo?.clientId ?? extra.sessionId ?? "anonymous";
    const spiffeId = readSpiffe(extra);
    return spiffeId ? { id, sessionId, spiffeId } : { id, sessionId };
  },
};
