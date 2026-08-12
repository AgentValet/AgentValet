/**
 * Approval-gated actions, and why a timeout is not a failure.
 *
 * When your owner marks a scope as requiring approval, the broker holds the
 * action and call() waits. If they approve in time, the proxy re-runs the call
 * and you get the result — from your code's point of view it simply took longer.
 *
 * If nobody responds within the budget you get ApprovalTimeoutError. **That is
 * not a failure.** The action is still queued server-side. Hold the approvalId
 * and resume later — in this process or a completely different one, hours later.
 *
 * Getting this wrong is the most common mistake: a developer catches the error,
 * treats it as a failure, and the action silently completes later with nobody
 * watching.
 */

import {
  AgentValet,
  ApprovalDeniedError,
  ApprovalExpiredError,
  ApprovalTimeoutError,
  UpstreamError,
} from "@agentvalet/client";

// --- Pattern A: block and wait (fine for interactive work) -------------------

const interactive = AgentValet.fromEnv({
  onApprovalPending: ({ elapsedMs }) =>
    process.stdout.write(`\r  waiting for owner... ${Math.round(elapsedMs / 1000)}s`),
});

try {
  const refund = await interactive.call({
    platform: "stripe",
    endpoint: "/v1/refunds",
    method: "POST",
    scope: "charge",
    data: { payment_intent: "pi_123", amount: 500 },
    reason: "Customer reported a duplicate charge (ticket #4412)",
  });
  console.log("\nrefunded:", refund);
} catch (err) {
  if (err instanceof ApprovalDeniedError) {
    // Terminal. The owner said no — do not retry, do not work around it.
    console.log(`\ndenied: ${err.message}`);
  } else if (err instanceof ApprovalExpiredError) {
    console.log("\nrequest expired server-side — re-issue it if still needed");
  } else if (err instanceof UpstreamError) {
    // Approved and executed, but Stripe itself rejected it.
    console.log(`\nstripe returned ${err.status}:`, err.data);
  } else {
    throw err;
  }
}

// --- Pattern B: don't block (correct for cron jobs and workers) --------------

const worker = AgentValet.fromEnv();

try {
  // approvalTimeoutMs: 0 means don't wait at all. You get the id immediately
  // and can go do something else.
  await worker.call({
    platform: "stripe",
    endpoint: "/v1/refunds",
    method: "POST",
    scope: "charge",
    data: { payment_intent: "pi_456", amount: 900 },
    reason: "Duplicate charge, batch job",
    approvalTimeoutMs: 0,
  });
} catch (err) {
  if (err instanceof ApprovalTimeoutError) {
    // Persist this. It is the whole state you need — nothing else about the
    // call has to be remembered.
    const { approvalId } = err;
    console.log("queued for approval:", approvalId);

    // ...later, in a worker process:
    try {
      const result = await worker.waitForApproval(approvalId, { timeoutMs: 30_000 });
      console.log("completed after the fact:", result);
    } catch (e) {
      if (e instanceof ApprovalTimeoutError) console.log("still pending — try again next tick");
      else throw e;
    }
  } else {
    throw err;
  }
}

// --- Pattern C: check before you act ----------------------------------------

// Dry-run the decision without performing the action. Worth doing before
// anything destructive, so you can tell the user "this needs approval" before
// they wait on it.
console.log("would be allowed:", await worker.evaluate("stripe", "charge"));
console.log("pending:", await worker.pendingActions());
