"""Smallest possible governed call.

    pip install agentvalet
    agentvalet register --code <invite-or-enrollment-code>
    python 01_quickstart.py

The point: there is no Slack token in this file, in your environment, or in
your process memory. AgentValet holds it, checks the call against what your
owner granted, injects the credential at request time, and writes an audit
record. Your agent only ever proves who it is.
"""

from agentvalet import AgentValet, AccessDeniedError

# from_env() needs no arguments on a machine that has run `agentvalet register`.
# It reads AGENTVALET_AGENT_ID / AGENTVALET_OWNER_ID (or the bare AGENT_ID /
# OWNER_ID) and finds the key at ~/.agentvalet/agent.key.
with AgentValet.from_env() as av:

    # What is this agent actually allowed to do? Deny-by-default: anything not
    # listed here will raise AccessDeniedError.
    grants = av.list_platforms()
    print("granted:", grants)

    try:
        result = av.call(
            platform="slack",
            endpoint="/api/chat.postMessage",
            method="POST",
            scope="chat:write",
            data={"channel": "#general", "text": "Deploy finished."},
            # Shown to whoever approves, if this scope is approval-gated.
            reason="Notify the team that the deploy completed",
        )
        print("sent:", result)

    except AccessDeniedError as err:
        # Not a crash — a governance decision your agent can act on.
        print(f"no grant for {err.platform}:{err.scope}")
        print("asking an admin...")
        decision = av.request_access(
            platform="slack",
            scope="chat:write",
            reason="Post deploy notifications to #general",
        )
        print("decision:", decision["status"])
