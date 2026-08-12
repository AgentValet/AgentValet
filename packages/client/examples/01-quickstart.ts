/**
 * Smallest possible governed call.
 *
 *   npm install @agentvalet/client
 *   npx @agentvalet/register
 *   npx tsx 01-quickstart.ts
 *
 * The point: there is no Slack token in this file, in your environment, or in
 * your process memory. AgentValet holds it, checks the call against what your
 * owner granted, injects the credential at request time, and writes an audit
 * record. Your agent only ever proves who it is.
 *
 * If you're inside Claude Code, Claude Desktop or Cursor, you don't need this
 * package at all — install @agentvalet/mcp-server and call use_platform.
 */

import { AgentValet, AccessDeniedError } from "@agentvalet/client";

// fromEnv() needs no arguments on a machine that has run `npx @agentvalet/register`.
const av = AgentValet.fromEnv();

// What is this agent actually allowed to do? Deny-by-default: anything not
// listed here throws AccessDeniedError.
console.log("granted:", await av.listPlatforms());

try {
  const result = await av.call({
    platform: "slack",
    endpoint: "/api/chat.postMessage",
    method: "POST",
    scope: "chat:write",
    data: { channel: "#general", text: "Deploy finished." },
    // Shown to whoever approves, if this scope is approval-gated.
    reason: "Notify the team that the deploy completed",
  });
  console.log("sent:", result);
} catch (err) {
  if (err instanceof AccessDeniedError) {
    // Not a crash — a governance decision your agent can act on.
    console.log(`no grant for ${err.platform}:${err.scope}, asking an admin...`);
    const decision = await av.requestAccess({
      platform: "slack",
      scope: "chat:write",
      reason: "Post deploy notifications to #general",
    });
    console.log("decision:", decision.status);
  } else {
    throw err;
  }
}
