"""Typed error hierarchy.

The point of the SDK over raw ``/v1/actions`` is that a caller can branch on
*why* a call failed without string-matching the proxy's error envelope. Every
exception raised by this package is one of these.
"""

from __future__ import annotations

from typing import Any

__all__ = [
    "AccessDeniedError",
    "AgentValetError",
    "ApprovalDeniedError",
    "ApprovalExpiredError",
    "ApprovalTimeoutError",
    "ConfigError",
    "NetworkError",
    "ProxyError",
    "UpstreamError",
]


class AgentValetError(Exception):
    """Base class for everything this package raises."""


class ConfigError(AgentValetError):
    """Missing or malformed identity/key. Raised before any network call."""


class NetworkError(AgentValetError):
    """The transport itself failed.

    ``hint`` diagnoses the likely cause (DNS, TLS interception, firewall,
    timeout) rather than leaving you with httpx's bare message.
    """

    def __init__(self, hint: str, cause: BaseException | None = None) -> None:
        super().__init__(hint)
        self.hint = hint
        self.cause = cause


class ProxyError(AgentValetError):
    """Non-2xx from the AgentValet broker that isn't a more specific case."""

    def __init__(self, status: int, body: str) -> None:
        super().__init__(f"Proxy error {status}: {body}")
        self.status = status
        self.body = body


class AccessDeniedError(ProxyError):
    """403 — no grant for this platform+scope, or policy blocked it.

    Recoverable: call :meth:`AgentValet.request_access`.
    """

    def __init__(self, status: int, body: str, platform: str, scope: str) -> None:
        super().__init__(status, body)
        self.platform = platform
        self.scope = scope
        self.args = (
            f"Access denied for {platform}:{scope} — {body}. "
            f"Call request_access(platform=..., scope=...) to ask an org admin to grant it.",
        )


class ApprovalDeniedError(AgentValetError):
    """The owner explicitly denied the action. Terminal — do not retry."""

    def __init__(self, approval_id: str, detail: str | None = None) -> None:
        super().__init__(f"Owner denied this action{f': {detail}' if detail else '.'}")
        self.approval_id = approval_id
        self.detail = detail


class ApprovalExpiredError(AgentValetError):
    """The approval request aged out server-side before anyone responded."""

    def __init__(self, approval_id: str) -> None:
        super().__init__("Approval request expired before the owner responded.")
        self.approval_id = approval_id


class ApprovalTimeoutError(AgentValetError):
    """We stopped waiting — but **this is not a failure**.

    The action is still queued server-side and will run if the owner approves.
    Hold ``approval_id`` and resume later with
    :meth:`AgentValet.wait_for_approval`, in this process or another one.
    """

    def __init__(self, approval_id: str, waited_s: float) -> None:
        super().__init__(
            f"Owner hasn't approved within {round(waited_s)}s. The action is still queued — "
            f"keep approval_id {approval_id} and call wait_for_approval(approval_id) to resume."
        )
        self.approval_id = approval_id
        self.waited_s = waited_s


class UpstreamError(AgentValetError):
    """Approved and executed, but the upstream SaaS returned a non-2xx."""

    def __init__(self, status: int, data: Any) -> None:
        super().__init__(f"Upstream returned {status}: {data!r}")
        self.status = status
        self.data = data
