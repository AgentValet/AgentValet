"""Behavioural contract with the AgentValet proxy.

These are NOT preferences. Each value is matched by
``packages/client/src/client.ts`` (TypeScript) and ``apps/mcp-server``. If one
of them changes here and not there, an operator debugging the Python SDK is no
longer debugging the same system as the Node one.

``tests/test_constants.py`` asserts every value, so changing one is a
deliberate, reviewed act rather than a drive-by edit.

Note the unit: the TypeScript client uses milliseconds; Python uses **seconds**,
matching the httpx/requests convention. The underlying values are the same.
"""

DEFAULT_PROXY_URL = "https://api.agentvalet.ai"

#: Approval long-poll budget. Sits under Claude Desktop's hardcoded 60s tool
#: timeout so the MCP path and the SDK path give up at the same moment.
APPROVAL_TIMEOUT_S = 50.0

#: How often we ask the proxy whether the owner has decided.
APPROVAL_POLL_S = 2.0

#: Per-request network timeout.
REQUEST_TIMEOUT_S = 15.0

#: Agent assertions are deliberately short-lived; the proxy rejects long-dated
#: ones. Seconds.
JWT_LIFETIME_S = 60

JWT_ALGORITHM = "RS256"
