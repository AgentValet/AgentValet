# Examples — `agentvalet` (Python)

Runnable use cases for the Python SDK. Each is standalone; read them in order
or jump to the one that matches what you're building.

```bash
pip install agentvalet
agentvalet register --code <invite-or-enrollment-code>
```

`register` generates an RSA keypair **on your machine** — only the public half
is sent — and writes `~/.agentvalet/agent.key`. After that `AgentValet.from_env()`
works with no arguments.

| File | Use case |
|---|---|
| [`01_quickstart.py`](./01_quickstart.py) | One governed call, and what to do when you lack the grant |
| [`02_approvals.py`](./02_approvals.py) | Approval-gated actions: blocking, non-blocking, and resuming later |
| [`03_langchain_tools.py`](./03_langchain_tools.py) | LangChain tools that can't exceed what the owner granted |
| [`04_support_triage_agent.py`](./04_support_triage_agent.py) | Overnight job across three platforms at three risk levels |

## The one thing to get right

`ApprovalTimeoutError` **is not a failure.** It means you stopped waiting — the
action is still queued and will run if the owner approves. Catch it, keep the
`approval_id`, and resume with `wait_for_approval()` later, from any process:

```python
try:
    av.call(platform="stripe", endpoint="/v1/refunds", method="POST",
            scope="charge", data={...})
except ApprovalTimeoutError as err:
    queue.put(err.approval_id)        # not an error path — a continuation
```

Treating it as an error is the most common mistake. The action completes later
regardless; you just stop being the one who hears about it.

## Errors worth branching on

| Error | Means | Do |
|---|---|---|
| `AccessDeniedError` | No grant, or policy blocked it | `request_access()`, or report back |
| `ApprovalDeniedError` | The owner said no | Stop. Don't retry or route around it |
| `ApprovalExpiredError` | Aged out unanswered | Re-issue if still needed |
| `ApprovalTimeoutError` | You stopped waiting | Resume via `wait_for_approval()` |
| `UpstreamError` | The SaaS itself rejected it | `.status` / `.data` hold its reply |
| `ConfigError` | Bad identity or key | Fix config — raised before any network call |

## Async

Every example works with `AsyncAgentValet`, which mirrors the sync class
method-for-method:

```python
from agentvalet import AsyncAgentValet

async with AsyncAgentValet.from_env() as av:
    result = await av.call(platform="slack", endpoint="/api/chat.postMessage",
                           method="POST", scope="chat:write", data={...})
```

## Note on the examples

They use real endpoints (`/api/chat.postMessage`, `/v1/refunds`) so you can run
them against your own connected platforms. They will raise `AccessDeniedError`
until the corresponding scope is granted — which is the system working, not a
bug. Start with `av.list_platforms()` to see what your agent actually has.
