"""Pure protocol logic — no I/O, no awaits.

Everything that decides *what* to send and *what a response means* lives here,
so the sync and async clients can share it verbatim. Only transport differs
between them. If you find yourself adding a branch to one client and not the
other, it belongs in this module instead.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from .errors import (
    AccessDeniedError,
    ApprovalDeniedError,
    ApprovalExpiredError,
    ProxyError,
    UpstreamError,
)


def build_action_body(
    platform: str,
    endpoint: str,
    scope: str,
    method: str = "GET",
    data: Any = None,
    connection_id: str | None = None,
    reason: str | None = None,
) -> dict[str, Any]:
    """Wire body for ``POST /v1/actions``.

    Optional fields are omitted entirely rather than sent as null — the proxy
    distinguishes absent from null for ``data``.
    """
    body: dict[str, Any] = {
        "platform": platform,
        "endpoint": endpoint,
        "method": method,
        "scope": scope,
    }
    if data is not None:
        body["data"] = data
    if connection_id:
        body["connection_id"] = connection_id
    if reason:
        body["reason"] = reason
    return body


def authzen_body(agent_id: str, platform: str, scope: str) -> dict[str, Any]:
    return {
        "subject": {"type": "agent", "id": agent_id},
        "action": {"name": "tool_call"},
        "resource": {"type": "platform_scope", "id": f"{platform}:{scope}"},
    }


def try_parse_json(text: str) -> Any:
    """Parse only if it looks structured; otherwise hand back the raw text.

    Mirrors the Node client so a non-JSON upstream body (a plain-text error,
    an empty 204) surfaces identically in both SDKs.
    """
    trimmed = text.strip()
    if not (trimmed.startswith("{") or trimmed.startswith("[")):
        return text
    try:
        return json.loads(trimmed)
    except ValueError:
        return text


def approval_id_from_202(text: str) -> str | None:
    parsed = try_parse_json(text)
    if isinstance(parsed, dict):
        value = parsed.get("approval_id")
        if isinstance(value, str):
            return value
    return None


def interpret_action_response(
    status: int, text: str, platform: str, scope: str
) -> Any:
    """Turn a ``/v1/actions`` reply into a value or the right exception.

    Callers must handle the 202 branch *before* this — an approval is a
    continuation, not a result.
    """
    if status == 403:
        # The proxy's authorize pipeline denies with 403 for both "no grant"
        # and "policy blocked". Its own type so callers can branch into
        # request_access() instead of dead-ending on a generic failure.
        raise AccessDeniedError(status, text, platform, scope)
    if not 200 <= status < 300:
        raise ProxyError(status, text)
    return try_parse_json(text)


def interpret_approval_status(payload: Mapping[str, Any], approval_id: str) -> tuple[bool, Any]:
    """Interpret one poll of ``GET /v1/approvals/:id``.

    Returns ``(done, value)``. ``done=False`` means keep polling. Terminal
    failures raise.
    """
    status = payload.get("status")

    if status == "denied":
        raise ApprovalDeniedError(approval_id, _as_str(payload.get("execution_error")))
    if status == "expired":
        raise ApprovalExpiredError(approval_id)

    execution_error = payload.get("execution_error")
    if execution_error:
        # Approved, but re-execution failed (upstream down, agent revoked
        # between approval and execution).
        raise ProxyError(502, f"Approved but re-execution failed: {execution_error}")

    if status == "approved" and payload.get("executed_at") and payload.get("result"):
        result = payload["result"]
        upstream_status = int(result.get("status", 0))
        if not 200 <= upstream_status < 300:
            raise UpstreamError(upstream_status, result.get("data"))
        return True, result.get("data")

    return False, None


def diagnose_network_error(err: BaseException, proxy_url: str) -> str:
    """Turn a transport failure into something a developer can act on.

    httpx's bare "Connection error" says nothing about whether it's DNS, a
    corporate MITM proxy, or the broker being down.
    """
    raw = str(err)
    lower = raw.lower()

    if "getaddrinfo" in lower or "name or service not known" in lower or "nodename" in lower:
        return (
            f"Cannot resolve {proxy_url}. Check DNS / corporate proxy / VPN, or confirm "
            f"proxy_url is correct. Raw: {raw}"
        )
    if "refused" in lower or "reset" in lower:
        return (
            f"Connection to {proxy_url} was refused or reset. The broker may be down — check "
            f"https://status.agentvalet.ai — or a firewall is blocking it. Raw: {raw}"
        )
    if "timeout" in lower or "timed out" in lower:
        return (
            f"Request to {proxy_url} timed out. Likely VPN routing, corporate proxy buffering, "
            f"or a slow network. Raw: {raw}"
        )
    if "certificate" in lower or "ssl" in lower or "tls" in lower:
        return (
            f"TLS / certificate problem talking to {proxy_url}. A corporate MITM proxy may be "
            f"intercepting traffic. Raw: {raw}"
        )
    return (
        f"Network error reaching {proxy_url}: {raw}. Check VPN, corporate proxy, and firewall "
        f"rules for api.agentvalet.ai."
    )


def _as_str(value: Any) -> str | None:
    return value if isinstance(value, str) else None
