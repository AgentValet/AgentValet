"""Use case: an overnight support triage agent.

A realistic shape — a scheduled job, no human watching, acting across three
platforms with different risk levels:

  read the inbox        low risk    runs unattended
  post a summary        medium      may need approval depending on policy
  issue a refund        destructive always pauses for a human

The interesting part is what happens when the human is asleep. The agent does
not block until morning and it does not skip the refund. It queues it, records
the approval id, finishes everything else, and exits. A later run picks the
approval back up. Nothing is lost and nothing is done without consent.

    pip install agentvalet
    agentvalet register --code <invite-or-enrollment-code>
    python 04_support_triage_agent.py
"""

import json
from pathlib import Path

from agentvalet import (
    AgentValet,
    AccessDeniedError,
    ApprovalDeniedError,
    ApprovalExpiredError,
    ApprovalTimeoutError,
)

# Where queued approvals survive between runs. A real deployment would use a
# database or job queue; a file keeps the example honest and runnable.
QUEUE = Path("pending_approvals.json")


def load_queue() -> list:
    return json.loads(QUEUE.read_text()) if QUEUE.exists() else []


def save_queue(items: list) -> None:
    QUEUE.write_text(json.dumps(items, indent=2))


def resume_pending(av: AgentValet) -> None:
    """Anything an earlier run left waiting for a human."""
    still_waiting = []
    for item in load_queue():
        try:
            # Short budget: this is a sweep, not a vigil.
            result = av.wait_for_approval(item["approval_id"], timeout_s=5)
            print(f"  [{item['what']}] approved while we were away -> {result}")
        except ApprovalTimeoutError:
            print(f"  [{item['what']}] still pending")
            still_waiting.append(item)
        except ApprovalDeniedError:
            print(f"  [{item['what']}] declined by owner — dropping")
        except ApprovalExpiredError:
            print(f"  [{item['what']}] expired unanswered — dropping")
    save_queue(still_waiting)


def main() -> None:
    with AgentValet.from_env() as av:
        print("resuming anything left from the last run:")
        resume_pending(av)
        queue = load_queue()

        # 1. Read — unattended, low risk.
        try:
            messages = av.call(
                platform="microsoft-outlook",
                endpoint="/me/messages?$top=10&$filter=isRead eq false",
                scope="Mail.Read",
            )
            count = len(messages.get("value", [])) if isinstance(messages, dict) else 0
            print(f"\n{count} unread support messages")
        except AccessDeniedError as err:
            print(f"\ncannot read mail: {err.scope} not granted — skipping triage")
            return

        # 2. Summarise to Slack — medium risk. If policy gates it, we do not
        #    want the whole job to stall, so give it a short budget and move on.
        try:
            av.call(
                platform="slack",
                endpoint="/api/chat.postMessage",
                method="POST",
                scope="chat:write",
                data={"channel": "#support", "text": f"Overnight triage: {count} unread."},
                reason="Nightly support triage summary",
                approval_timeout_s=10,
            )
            print("posted summary to #support")
        except ApprovalTimeoutError as err:
            queue.append({"approval_id": err.approval_id, "what": "slack summary"})
            print("summary queued for approval")
        except AccessDeniedError:
            print("no slack grant — summary skipped")

        # 3. Refund — destructive. Never block a nightly job on a sleeping
        #    human; queue it and let a later run collect the decision.
        for refund in [{"payment_intent": "pi_123", "amount": 500}]:
            try:
                av.call(
                    platform="stripe",
                    endpoint="/v1/refunds",
                    method="POST",
                    scope="charge",
                    data=refund,
                    reason=f"Duplicate charge flagged in overnight triage ({refund['payment_intent']})",
                    approval_timeout_s=0,  # do not wait at all
                )
                print("refund issued without approval (policy allows it)")
            except ApprovalTimeoutError as err:
                queue.append(
                    {"approval_id": err.approval_id, "what": f"refund {refund['payment_intent']}"}
                )
                print(f"refund queued for approval: {err.approval_id}")
            except ApprovalDeniedError:
                print("refund declined")

        save_queue(queue)
        print(f"\ndone. {len(queue)} action(s) awaiting a human.")


if __name__ == "__main__":
    main()
