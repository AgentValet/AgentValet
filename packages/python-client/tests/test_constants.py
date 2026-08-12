"""Pins the wire contract shared with the Node SDK and apps/mcp-server.

These are not preferences. If a value here changes without the corresponding
change in ``packages/client/src/client.ts`` and ``apps/mcp-server``, the two
paths give up at different moments and an operator can no longer reason about
one from the other. This test exists to make such a change deliberate.
"""

from agentvalet import _constants as c


def test_approval_budget_matches_the_node_sdk():
    # 50s, chosen to sit under Claude Desktop's hardcoded 60s tool timeout.
    assert c.APPROVAL_TIMEOUT_S == 50.0


def test_approval_poll_interval_matches_the_node_sdk():
    assert c.APPROVAL_POLL_S == 2.0


def test_request_timeout_matches_the_node_sdk():
    assert c.REQUEST_TIMEOUT_S == 15.0


def test_assertions_are_short_lived_rs256():
    assert c.JWT_LIFETIME_S == 60
    assert c.JWT_ALGORITHM == "RS256"


def test_default_proxy_url():
    assert c.DEFAULT_PROXY_URL == "https://api.agentvalet.ai"
