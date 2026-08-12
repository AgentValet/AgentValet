# agentvalet

Call approved SaaS platforms from any Python agent. Your agent never holds the
downstream credential — AgentValet signs a short-lived identity assertion,
checks the call against the owner's grants and policy, injects the credential at
call time, and writes an audit record.

This is the Python port of
[`@agentvalet/client`](https://www.npmjs.com/package/@agentvalet/client). Same
endpoints, same approval semantics, same timings.

## Install

```bash
pip install agentvalet
```

Python 3.9+. Two dependencies: `httpx` and `pyjwt[crypto]`.

## Get an agent identity

```bash
agentvalet register --code <invite-or-enrollment-code>
```

The RSA keypair is generated **on your machine**. Only the public half is sent;
the private key is written to `~/.agentvalet/agent.key` (mode 0600) and never
crosses the wire. The code is either an invite's bind secret or the enrollment
code from the "Try it free" flow.

This writes the same files as `npx @agentvalet/register`, so the Node and Python
tooling are interchangeable — you do not need Node installed.

## Use it

```python
from agentvalet import AgentValet

av = AgentValet.from_env()

result = av.call(
    platform="slack",
    endpoint="/api/chat.postMessage",
    method="POST",
    scope="chat:write",
    data={"channel": "#general", "text": "Deploy finished."},
)
```

`from_env()` reads `AGENTVALET_AGENT_ID` / `AGENTVALET_OWNER_ID` (or the bare
`AGENT_ID` / `OWNER_ID`) and finds the key via `AGENT_PRIVATE_KEY_B64`,
`AGENT_PRIVATE_KEY_PATH`, `AGENT_PRIVATE_KEY`, or `~/.agentvalet/agent.key`. To
wire it explicitly:

```python
av = AgentValet(
    agent_id=os.environ["AGENT_ID"],
    owner_id=os.environ["OWNER_ID"],
    private_key=os.environ["AGENT_PRIVATE_KEY"],
    proxy_url="https://api.agentvalet.ai",   # default
)
```

Use it as a context manager to close the HTTP client cleanly:

```python
with AgentValet.from_env() as av:
    av.call(platform="github", endpoint="/user", scope="read")
```

## Async

`AsyncAgentValet` is a method-for-method mirror. All decision logic is shared,
and the test suite runs the same behaviour table against both.

```python
from agentvalet import AsyncAgentValet

async with AsyncAgentValet.from_env() as av:
    result = await av.call(
        platform="slack", endpoint="/api/chat.postMessage",
        method="POST", scope="chat:write", data={...},
    )
```

## Approvals are just a slower call

When the owner has marked a scope as approval-gated, the proxy holds the action
and `call()` waits. If the owner approves, the proxy re-runs the call and you
get the result — from your code's point of view it simply took longer.

```python
av = AgentValet.from_env(
    on_approval_pending=lambda i: print(f"waiting… {i['elapsed_s']:.0f}s")
)
```

If nobody responds inside the budget (50s by default), you get an
`ApprovalTimeoutError` — **not a failure**. The action stays queued. Keep the
`approval_id` and resume whenever you like, in this process or another:

```python
from agentvalet import ApprovalTimeoutError

try:
    av.call(platform="stripe", endpoint="/v1/refunds", method="POST", scope="charge")
except ApprovalTimeoutError as err:
    queue.put(err.approval_id)          # hand off to a worker

# …later, elsewhere:
result = av.wait_for_approval(approval_id)
```

Pass `approval_timeout_s=0` if you never want to block.

## Errors you can branch on

Every exception is typed, so you never string-match an error envelope:

| Error | Means | What to do |
|---|---|---|
| `ConfigError` | Bad/missing identity or key | Fix config; raised before any network call |
| `NetworkError` | Transport failed | `.hint` diagnoses DNS / TLS / firewall / timeout |
| `AccessDeniedError` | No grant, or policy blocked it | `request_access()` — see below |
| `ApprovalDeniedError` | Owner said no | Terminal. Don't retry |
| `ApprovalExpiredError` | Aged out server-side | Re-issue the call |
| `ApprovalTimeoutError` | You stopped waiting | Resume via `wait_for_approval()` |
| `UpstreamError` | The SaaS returned non-2xx | `.status` / `.data` hold the upstream reply |
| `ProxyError` | Anything else from the broker | `.status` / `.body` |

## Asking for access you don't have

Deny-by-default means a scope you were never granted raises
`AccessDeniedError`. Your agent can ask for it:

```python
result = av.request_access(
    platform="slack",
    scope="chat:write",
    reason="Post deploy notifications to #general",
)
if result["status"] == "approved":
    ...  # retry the original call
```

## Checking before you act

```python
av.list_platforms()                 # what this agent is actually granted
av.pending_actions()                # queued behind an approval
av.evaluate("stripe", "charge")     # dry-run the decision, no side effect
```

`evaluate()` is worth calling before anything destructive.

## Self-hosting

Point `proxy_url` at your own deployment. Everything else is identical.

## License

MIT
