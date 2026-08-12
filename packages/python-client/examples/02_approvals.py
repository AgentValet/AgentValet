"""Approval-gated actions, and why a timeout is not a failure.

When your owner marks a scope as requiring approval, the broker holds the
action and `call()` waits. If they approve in time, the proxy re-runs the call
and you get the result — from your code's point of view it simply took longer.

If nobody responds within the budget you get ApprovalTimeoutError. **That is
not a failure.** The action is still queued server-side. Hold the approval_id
and resume later — in this process or a completely different one, hours later.

Getting this wrong is the most common mistake: a developer catches the
exception, treats it as an error, and the action silently completes later with
nobody watching.
"""

import time

from agentvalet import (
    AgentValet,
    ApprovalDeniedError,
    ApprovalExpiredError,
    ApprovalTimeoutError,
    UpstreamError,
)


def on_pending(info):
    """Called each poll while an approval is outstanding — good for a spinner."""
    print(f"  waiting for owner... {info['elapsed_s']:.0f}s", end="\r")


# --- Pattern A: block and wait (fine for interactive work) -------------------

with AgentValet.from_env(on_approval_pending=on_pending) as av:
    try:
        refund = av.call(
            platform="stripe",
            endpoint="/v1/refunds",
            method="POST",
            scope="charge",
            data={"payment_intent": "pi_123", "amount": 500},
            reason="Customer reported a duplicate charge (ticket #4412)",
        )
        print("\nrefunded:", refund)

    except ApprovalDeniedError as err:
        # Terminal. The owner said no — do not retry, do not work around it.
        print(f"\ndenied: {err}")

    except ApprovalExpiredError:
        print("\nrequest expired server-side — re-issue it if still needed")

    except UpstreamError as err:
        # Approved and executed, but Stripe itself rejected it.
        print(f"\nstripe returned {err.status}: {err.data}")


# --- Pattern B: don't block (correct for cron jobs and workers) --------------

with AgentValet.from_env() as av:
    try:
        # approval_timeout_s=0 means: don't wait at all. You get the id
        # immediately and can go do something else.
        av.call(
            platform="stripe",
            endpoint="/v1/refunds",
            method="POST",
            scope="charge",
            data={"payment_intent": "pi_456", "amount": 900},
            reason="Duplicate charge, batch job",
            approval_timeout_s=0,
        )
    except ApprovalTimeoutError as err:
        approval_id = err.approval_id
        print(f"queued for approval: {approval_id}")
        # Persist this in your job queue / database. It is the whole state you
        # need — nothing else about the call has to be remembered.

        # ...later, in a worker process:
        time.sleep(1)
        with AgentValet.from_env() as av2:
            try:
                result = av2.wait_for_approval(approval_id, timeout_s=30)
                print("completed after the fact:", result)
            except ApprovalTimeoutError:
                print("still pending — try again next tick")


# --- Pattern C: check before you act ----------------------------------------

with AgentValet.from_env() as av:
    # Dry-run the decision without performing the action. Worth doing before
    # anything destructive, so you can tell the user "this needs approval"
    # before they wait on it.
    decision = av.evaluate("stripe", "charge")
    print("would be allowed:", decision)

    # Anything already queued behind an approval:
    print("pending:", av.pending_actions())
