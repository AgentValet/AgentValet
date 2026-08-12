"""Behaviour table, run against both the sync and async clients.

Mirrors ``packages/client/tests/client.test.ts`` case for case. A case that
exists on one side only is a signal the SDKs have diverged.
"""

import jwt
import pytest
import respx
from conftest import PROXY, invoke
from httpx import ConnectError, Response

from agentvalet import (
    AccessDeniedError,
    ApprovalDeniedError,
    ApprovalExpiredError,
    ApprovalTimeoutError,
    ConfigError,
    NetworkError,
    ProxyError,
    UpstreamError,
)

pytestmark = pytest.mark.asyncio


def approval(**over):
    payload = {
        "approval_id": "apr_1",
        "status": "pending",
        "expires_at": "",
        "executed_at": None,
        "created_at": "",
    }
    payload.update(over)
    return payload


# -- construction ---------------------------------------------------------


async def test_rejects_missing_identity_or_key(make_client, private_key_pem):
    cls = make_client.cls
    with pytest.raises(ConfigError):
        cls(agent_id="", owner_id="o", private_key=private_key_pem)
    with pytest.raises(ConfigError):
        cls(agent_id="a", owner_id="", private_key=private_key_pem)
    with pytest.raises(ConfigError):
        cls(agent_id="a", owner_id="o", private_key="")


async def test_strips_trailing_slash_from_proxy_url(make_client):
    assert make_client(proxy_url="https://x.test/").proxy_url == "https://x.test"


async def test_from_env_names_the_vars_when_identity_absent(make_client, monkeypatch):
    for name in ("AGENTVALET_AGENT_ID", "AGENT_ID", "AGENTVALET_OWNER_ID", "OWNER_ID"):
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(ConfigError, match="AGENTVALET_AGENT_ID"):
        make_client.cls.from_env()


# -- signing --------------------------------------------------------------


async def test_signs_rs256_with_agent_and_owner_claims(client):
    token = client.sign_jwt()
    assert jwt.get_unverified_header(token)["alg"] == "RS256"
    claims = jwt.decode(token, options={"verify_signature": False})
    assert claims["agent_id"] == "agt_test"
    assert claims["owner_id"] == "own_test"
    # Short-lived: the proxy rejects long-dated agent assertions.
    assert claims["exp"] - claims["iat"] == 60


async def test_malformed_key_surfaces_as_config_error(make_client):
    bad = make_client(private_key="-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----")
    with pytest.raises(ConfigError):
        bad.sign_jwt()


# -- call -----------------------------------------------------------------


@respx.mock
async def test_returns_upstream_body_and_sends_bearer(client):
    route = respx.post(f"{PROXY}/v1/actions").mock(
        return_value=Response(200, json={"ok": True, "ts": "1"})
    )

    result = await invoke(
        client, "call",
        platform="slack", endpoint="/api/chat.postMessage", method="POST",
        scope="chat:write", data={"channel": "#general", "text": "hi"},
    )

    assert result == {"ok": True, "ts": "1"}
    request = route.calls[0].request
    assert request.headers["authorization"].startswith("Bearer ey")


@respx.mock
async def test_defaults_method_to_get_and_omits_absent_fields(client):
    import json as _json

    route = respx.post(f"{PROXY}/v1/actions").mock(return_value=Response(200, json={}))
    await invoke(client, "call", platform="github", endpoint="/user", scope="read")

    body = _json.loads(route.calls[0].request.content)
    assert body["method"] == "GET"
    assert "data" not in body
    assert "connection_id" not in body
    assert "reason" not in body


@respx.mock
async def test_forwards_connection_id_and_reason_under_wire_names(client):
    import json as _json

    route = respx.post(f"{PROXY}/v1/actions").mock(return_value=Response(200, json={}))
    await invoke(
        client, "call", platform="slack", endpoint="/x", scope="s",
        connection_id="conn_1", reason="weekly digest",
    )

    body = _json.loads(route.calls[0].request.content)
    assert body["connection_id"] == "conn_1"
    assert body["reason"] == "weekly digest"


@respx.mock
async def test_403_becomes_access_denied_pointing_at_request_access(client):
    respx.post(f"{PROXY}/v1/actions").mock(
        return_value=Response(403, json={"error": "scope not granted"})
    )

    with pytest.raises(AccessDeniedError) as excinfo:
        await invoke(client, "call", platform="stripe", endpoint="/v1/charges", scope="charge")

    assert excinfo.value.platform == "stripe"
    assert excinfo.value.scope == "charge"
    assert "request_access" in str(excinfo.value)


@respx.mock
async def test_other_non_2xx_becomes_proxy_error(client):
    respx.post(f"{PROXY}/v1/actions").mock(return_value=Response(500, text="boom"))

    with pytest.raises(ProxyError) as excinfo:
        await invoke(client, "call", platform="p", endpoint="/e", scope="s")

    assert excinfo.value.status == 500


@respx.mock
async def test_retries_exactly_once_on_401(client):
    route = respx.post(f"{PROXY}/v1/actions").mock(
        side_effect=[Response(401, json={"error": "clock skew"}), Response(200, json={"ok": True})]
    )

    result = await invoke(client, "call", platform="p", endpoint="/e", scope="s")

    assert result == {"ok": True}
    assert route.call_count == 2


@respx.mock
async def test_transport_failure_becomes_network_error_with_hint(client):
    respx.post(f"{PROXY}/v1/actions").mock(
        side_effect=ConnectError("getaddrinfo failed")
    )

    with pytest.raises(NetworkError, match="Cannot resolve"):
        await invoke(client, "call", platform="p", endpoint="/e", scope="s")


# -- approval long-poll ---------------------------------------------------


@respx.mock
async def test_waits_out_202_and_returns_reexecuted_result(client):
    respx.post(f"{PROXY}/v1/actions").mock(
        return_value=Response(202, json={"approval_id": "apr_1"})
    )
    respx.get(f"{PROXY}/v1/approvals/apr_1").mock(
        side_effect=[
            Response(200, json=approval()),
            Response(
                200,
                json=approval(
                    status="approved", executed_at="now", result={"status": 200, "data": {"sent": True}}
                ),
            ),
        ]
    )

    result = await invoke(client, "call", platform="slack", endpoint="/x", scope="chat:write")
    assert result == {"sent": True}


@respx.mock
async def test_owner_denial_raises_approval_denied(client):
    respx.post(f"{PROXY}/v1/actions").mock(return_value=Response(202, json={"approval_id": "apr_1"}))
    respx.get(f"{PROXY}/v1/approvals/apr_1").mock(
        return_value=Response(200, json=approval(status="denied"))
    )

    with pytest.raises(ApprovalDeniedError) as excinfo:
        await invoke(client, "call", platform="p", endpoint="/e", scope="s")
    assert excinfo.value.approval_id == "apr_1"


@respx.mock
async def test_server_side_expiry_raises_approval_expired(client):
    respx.post(f"{PROXY}/v1/actions").mock(return_value=Response(202, json={"approval_id": "apr_1"}))
    respx.get(f"{PROXY}/v1/approvals/apr_1").mock(
        return_value=Response(200, json=approval(status="expired"))
    )

    with pytest.raises(ApprovalExpiredError):
        await invoke(client, "call", platform="p", endpoint="/e", scope="s")


@respx.mock
async def test_approved_but_upstream_4xx_raises_upstream_error(client):
    respx.post(f"{PROXY}/v1/actions").mock(return_value=Response(202, json={"approval_id": "apr_1"}))
    respx.get(f"{PROXY}/v1/approvals/apr_1").mock(
        return_value=Response(
            200,
            json=approval(
                status="approved", executed_at="now", result={"status": 422, "data": {"err": "bad"}}
            ),
        )
    )

    with pytest.raises(UpstreamError) as excinfo:
        await invoke(client, "call", platform="p", endpoint="/e", scope="s")
    assert excinfo.value.status == 422


@respx.mock
async def test_approved_but_reexecution_failed_raises_proxy_error(client):
    respx.post(f"{PROXY}/v1/actions").mock(return_value=Response(202, json={"approval_id": "apr_1"}))
    respx.get(f"{PROXY}/v1/approvals/apr_1").mock(
        return_value=Response(200, json=approval(execution_error="upstream unreachable"))
    )

    with pytest.raises(ProxyError, match="re-execution failed"):
        await invoke(client, "call", platform="p", endpoint="/e", scope="s")


@respx.mock
async def test_timeout_carries_a_resumable_approval_id(make_client):
    client = make_client(approval_timeout_s=0.05)
    respx.post(f"{PROXY}/v1/actions").mock(return_value=Response(202, json={"approval_id": "apr_1"}))
    respx.get(f"{PROXY}/v1/approvals/apr_1").mock(return_value=Response(200, json=approval()))

    with pytest.raises(ApprovalTimeoutError) as excinfo:
        await invoke(client, "call", platform="p", endpoint="/e", scope="s")

    assert excinfo.value.approval_id == "apr_1"
    # The message must say the action is still queued — a dev's instinct is to
    # treat any exception as terminal.
    assert "wait_for_approval" in str(excinfo.value)
    assert "still queued" in str(excinfo.value)


@respx.mock
async def test_wait_for_approval_resumes_by_id(client):
    respx.get(f"{PROXY}/v1/approvals/apr_9").mock(
        return_value=Response(
            200,
            json=approval(
                status="approved", executed_at="now", result={"status": 200, "data": {"late": True}}
            ),
        )
    )

    assert await invoke(client, "wait_for_approval", "apr_9") == {"late": True}


@respx.mock
async def test_reports_progress_while_waiting(make_client):
    seen = []
    client = make_client(on_approval_pending=lambda info: seen.append(info["elapsed_s"]))

    respx.post(f"{PROXY}/v1/actions").mock(return_value=Response(202, json={"approval_id": "apr_1"}))
    respx.get(f"{PROXY}/v1/approvals/apr_1").mock(
        side_effect=[
            Response(200, json=approval()),
            Response(
                200,
                json=approval(status="approved", executed_at="now", result={"status": 200, "data": 1}),
            ),
        ]
    )

    await invoke(client, "call", platform="slack", endpoint="/x", scope="chat:write")
    assert seen


# -- discovery and governance --------------------------------------------


@respx.mock
async def test_list_platforms_hits_permissions_endpoint(client):
    route = respx.get(f"{PROXY}/v1/agent/permissions").mock(
        return_value=Response(200, json={"platforms": []})
    )
    await invoke(client, "list_platforms")
    assert route.called


@respx.mock
async def test_pending_actions_hits_agent_pending_endpoint(client):
    route = respx.get(f"{PROXY}/v1/agents/me/pending-actions").mock(
        return_value=Response(200, json=[])
    )
    await invoke(client, "pending_actions")
    assert route.called


@respx.mock
async def test_evaluate_posts_authzen_triple(client):
    import json as _json

    route = respx.post(f"{PROXY}/v1/authzen/access").mock(
        return_value=Response(200, json={"decision": False})
    )
    await invoke(client, "evaluate", "stripe", "charge")

    assert _json.loads(route.calls[0].request.content) == {
        "subject": {"type": "agent", "id": "agt_test"},
        "action": {"name": "tool_call"},
        "resource": {"type": "platform_scope", "id": "stripe:charge"},
    }


@respx.mock
async def test_request_access_submits_then_polls_to_approved(client):
    respx.post(f"{PROXY}/v1/access-request").mock(
        return_value=Response(202, json={"request_token": "req_1"})
    )
    respx.get(f"{PROXY}/v1/access-request/status/req_1").mock(
        side_effect=[
            Response(200, json={"status": "pending"}),
            Response(200, json={"status": "approved"}),
        ]
    )

    result = await invoke(
        client, "request_access", platform="slack", scope="chat:write", reason="digest"
    )
    assert result == {"status": "approved", "request_token": "req_1"}


@respx.mock
async def test_request_access_returns_pending_when_nobody_decides(make_client):
    client = make_client(approval_timeout_s=0.05)
    respx.post(f"{PROXY}/v1/access-request").mock(
        return_value=Response(202, json={"request_token": "req_1"})
    )
    respx.get(f"{PROXY}/v1/access-request/status/req_1").mock(
        return_value=Response(200, json={"status": "pending"})
    )

    result = await invoke(client, "request_access", platform="slack")
    assert result["status"] == "pending"
