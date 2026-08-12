/**
 * Use case: a deploy bot running in CI.
 *
 * A realistic shape — an unattended process acting across platforms at
 * different risk levels, with nobody watching:
 *
 *   read the commit range   low risk     runs unattended
 *   post to Slack           medium       may need approval depending on policy
 *   create a release tag    write        audited, may need approval
 *
 * The interesting part is that CI cannot wait. A pipeline that blocks 50s per
 * approval-gated call is a pipeline nobody keeps. So this queues anything that
 * needs a human, finishes the rest, and reports what is outstanding — the build
 * goes green and the human decides in their own time.
 *
 *   npm install @agentvalet/client
 *   npx tsx 03-deploy-bot.ts
 *
 * In CI, supply identity via env rather than ~/.agentvalet:
 *   AGENT_ID, OWNER_ID, AGENT_PRIVATE_KEY_B64  (base64 PEM — container-safe)
 */

import {
  AgentValet,
  AccessDeniedError,
  ApprovalDeniedError,
  ApprovalTimeoutError,
} from "@agentvalet/client";

const SHA = process.env.GITHUB_SHA ?? "unknown";
const REPO = process.env.GITHUB_REPOSITORY ?? "acme/widgets";

const av = AgentValet.fromEnv();
const queued: Array<{ approvalId: string; what: string }> = [];

/** Run an action, but never let CI block on a human. */
async function withoutBlocking<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApprovalTimeoutError) {
      queued.push({ approvalId: err.approvalId, what });
      console.log(`  ${what}: queued for approval (${err.approvalId})`);
      return null;
    }
    if (err instanceof AccessDeniedError) {
      // A missing grant should not fail the build — report it and carry on.
      console.log(`  ${what}: skipped, no grant for ${err.platform}:${err.scope}`);
      return null;
    }
    if (err instanceof ApprovalDeniedError) {
      console.log(`  ${what}: declined by owner`);
      return null;
    }
    throw err; // genuine failures still fail the build
  }
}

console.log(`deploy bot for ${REPO}@${SHA.slice(0, 7)}`);

// 1. Read — unattended, low risk.
const commit = await withoutBlocking("read commit", () =>
  av.call({
    platform: "github",
    endpoint: `/repos/${REPO}/commits/${SHA}`,
    scope: "github:contents.read",
  }),
);

const summary = commit ? `Deployed ${SHA.slice(0, 7)}` : `Deployed ${SHA.slice(0, 7)} (details unavailable)`;

// 2. Announce — medium risk. Short budget: if a human is around they can
//    approve it in seconds; if not, we move on rather than stall the pipeline.
await withoutBlocking("slack announce", () =>
  av.call({
    platform: "slack",
    endpoint: "/api/chat.postMessage",
    method: "POST",
    scope: "chat:write",
    data: { channel: "#deploys", text: summary },
    reason: `Deploy notification for ${REPO}@${SHA.slice(0, 7)}`,
    approvalTimeoutMs: 10_000,
  }),
);

// 3. Write — do not wait at all. A release tag is not worth a stalled build.
await withoutBlocking("create release", () =>
  av.call({
    platform: "github",
    endpoint: `/repos/${REPO}/releases`,
    method: "POST",
    scope: "github:contents.write",
    data: { tag_name: `deploy-${SHA.slice(0, 7)}`, name: summary },
    reason: `Tag the deployed commit for ${REPO}`,
    approvalTimeoutMs: 0,
  }),
);

if (queued.length) {
  console.log(`\n${queued.length} action(s) awaiting a human:`);
  for (const q of queued) console.log(`  ${q.what} -> ${q.approvalId}`);
  // Persist these (job queue, workflow artifact, an issue comment) so a later
  // run can call av.waitForApproval(approvalId) and collect the outcome.
  // Exit 0 deliberately: pending approval is not a build failure.
}
console.log("\ndone.");
