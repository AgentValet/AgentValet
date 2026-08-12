"""Synchronous AgentValet client.

Sync is the default because most Python agent code is synchronous. See
:mod:`agentvalet.aio` for the async mirror — same methods, same semantics.
"""

from __future__ import annotations

import time
from typing import Any, Callable

import httpx

from ._constants import (
    APPROVAL_POLL_S,
    APPROVAL_TIMEOUT_S,
    DEFAULT_PROXY_URL,
    REQUEST_TIMEOUT_S,
)
from ._protocol import (
    approval_id_from_202,
    authzen_body,
    build_action_body,
    diagnose_network_error,
    interpret_action_response,
    interpret_approval_status,
    try_parse_json,
)
from ._signing import sign_jwt
from .env import agent_id_from_env, owner_id_from_env, private_key_from_env, proxy_url_from_env
from .errors import ApprovalTimeoutError, ConfigError, NetworkError, ProxyError

__all__ = ["AgentValet"]

ProgressCallback = Callable[[dict[str, Any]], None]


class AgentValet:
    """Calls approved SaaS platforms through the AgentValet broker.

    The agent never holds the downstream credential: this client signs a
    short-lived identity assertion, the broker checks it against the owner's
    grants and policy, injects the credential at call time, and writes an audit
    record.
    """

    def __init__(
        self,
        agent_id: str,
        owner_id: str,
        private_key: str,
        proxy_url: str = DEFAULT_PROXY_URL,
        timeout_s: float = REQUEST_TIMEOUT_S,
        approval_timeout_s: float = APPROVAL_TIMEOUT_S,
        approval_poll_s: float = APPROVAL_POLL_S,
        on_approval_pending: ProgressCallback | None = None,
        transport: httpx.Client | None = None,
    ) -> None:
        if not agent_id:
            raise ConfigError("agent_id is required")
        if not owner_id:
            raise ConfigError("owner_id is required")
        if not private_key:
            raise ConfigError("private_key is required")

        self.agent_id = agent_id
        self.owner_id = owner_id
        self.proxy_url = proxy_url.rstrip("/")
        self._private_key = private_key
        self._timeout_s = timeout_s
        self._approval_timeout_s = approval_timeout_s
        self._approval_poll_s = approval_poll_s
        self._on_approval_pending = on_approval_pending
        self._owns_client = transport is None
        self._http = transport or httpx.Client(timeout=timeout_s)

    @classmethod
    def from_env(cls, **overrides: Any) -> AgentValet:
        """Build a client from the environment.

        Works with no arguments on a machine that has run ``agentvalet
        register`` (or ``npx @agentvalet/register``). See :mod:`agentvalet.env`
        for the accepted variable names and key formats.
        """
        agent_id = overrides.pop("agent_id", None) or agent_id_from_env()
        owner_id = overrides.pop("owner_id", None) or owner_id_from_env()
        if not agent_id or not owner_id:
            raise ConfigError(
                "AgentValet identity not found in the environment. Set AGENTVALET_AGENT_ID and "
                "AGENTVALET_OWNER_ID (or AGENT_ID / OWNER_ID), or run `agentvalet register`."
            )
        return cls(
            agent_id=agent_id,
            owner_id=owner_id,
            private_key=overrides.pop("private_key", None) or private_key_from_env(),
            proxy_url=overrides.pop("proxy_url", None) or proxy_url_from_env(),
            **overrides,
        )

    # -- context manager ---------------------------------------------------

    def __enter__(self) -> AgentValet:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def close(self) -> None:
        """Close the underlying HTTP client, if we created it."""
        if self._owns_client:
            self._http.close()

    # -- core --------------------------------------------------------------

    def call(
        self,
        platform: str,
        endpoint: str,
        scope: str,
        method: str = "GET",
        data: Any = None,
        connection_id: str | None = None,
        reason: str | None = None,
        approval_timeout_s: float | None = None,
    ) -> Any:
        """Call an approved platform. Returns the upstream SaaS body, parsed.

        If the owner must approve, this blocks for up to ``approval_timeout_s``
        and then returns the result transparently — from your code's point of
        view an approved call simply took longer.

        Raises:
            AccessDeniedError: no grant for this platform+scope, or policy
                blocked it. Recover with :meth:`request_access`.
            ApprovalDeniedError: the owner said no. Terminal.
            ApprovalTimeoutError: nobody responded in time. **Not a failure** —
                the action stays queued; resume with :meth:`wait_for_approval`.
            UpstreamError: approved and executed, but the SaaS returned non-2xx.
        """
        body = build_action_body(
            platform=platform,
            endpoint=endpoint,
            scope=scope,
            method=method,
            data=data,
            connection_id=connection_id,
            reason=reason,
        )
        response = self._authed_request("POST", "/v1/actions", json=body)
        text = response.text

        if response.status_code == 202:
            approval_id = approval_id_from_202(text)
            if approval_id:
                return self.wait_for_approval(
                    approval_id,
                    platform=platform,
                    scope=scope,
                    endpoint=endpoint,
                    timeout_s=approval_timeout_s,
                )

        return interpret_action_response(response.status_code, text, platform, scope)

    def wait_for_approval(
        self,
        approval_id: str,
        platform: str = "",
        scope: str = "",
        endpoint: str = "",
        timeout_s: float | None = None,
    ) -> Any:
        """Resume waiting on an outstanding approval.

        Use with the ``approval_id`` from a caught
        :class:`~agentvalet.errors.ApprovalTimeoutError` — the action is queued
        server-side, so this picks up exactly where :meth:`call` left off, even
        in a different process.
        """
        budget = self._approval_timeout_s if timeout_s is None else timeout_s
        started = time.monotonic()

        while time.monotonic() - started < budget:
            time.sleep(self._approval_poll_s)
            elapsed = time.monotonic() - started

            try:
                response = self._authed_request("GET", f"/v1/approvals/{approval_id}")
            except NetworkError:
                continue  # transient — try again next tick

            if response.status_code >= 400:
                raise ProxyError(response.status_code, response.text)

            done, value = interpret_approval_status(response.json(), approval_id)
            if done:
                return value

            if self._on_approval_pending:
                self._on_approval_pending(
                    {
                        "approval_id": approval_id,
                        "elapsed_s": elapsed,
                        "platform": platform,
                        "scope": scope,
                        "endpoint": endpoint,
                    }
                )

        raise ApprovalTimeoutError(approval_id, budget)

    # -- discovery / governance -------------------------------------------

    def list_platforms(self) -> Any:
        """Platforms and scopes this agent is actually granted.

        Deny-by-default: if it isn't here, :meth:`call` will raise
        :class:`~agentvalet.errors.AccessDeniedError`.
        """
        return self._get_json("/v1/agent/permissions")

    def pending_actions(self) -> Any:
        """Actions queued behind an owner approval that haven't resolved."""
        return self._get_json("/v1/agents/me/pending-actions")

    def evaluate(self, platform: str, scope: str) -> Any:
        """Dry-run an authorization decision without performing the action.

        Worth calling before anything destructive — it tells you whether the
        action would be allowed, with no side effect.
        """
        response = self._authed_request(
            "POST", "/v1/authzen/access", json=authzen_body(self.agent_id, platform, scope)
        )
        if response.status_code >= 400:
            raise ProxyError(response.status_code, response.text)
        return try_parse_json(response.text)

    def request_access(
        self,
        platform: str,
        scope: str | None = None,
        reason: str | None = None,
        timeout_s: float | None = None,
    ) -> dict[str, str]:
        """Ask an org admin to grant platform+scope, then poll for the decision.

        Returns ``{"status": "approved"|"denied"|"pending", "request_token": ...}``.
        On ``approved``, retry the original :meth:`call`.
        """
        submit = self._authed_request(
            "POST",
            "/v1/access-request",
            json={"platform": platform, "scope": scope, "reason": reason},
        )
        if submit.status_code >= 400:
            raise ProxyError(submit.status_code, submit.text)

        token = submit.json().get("request_token")
        if not token:
            raise ProxyError(submit.status_code, "Access request did not return a request_token.")

        budget = self._approval_timeout_s if timeout_s is None else timeout_s
        deadline = time.monotonic() + budget
        while time.monotonic() < deadline:
            time.sleep(self._approval_poll_s)
            try:
                status_res = self._authed_request(
                    "GET", f"/v1/access-request/status/{token}"
                )
            except NetworkError:
                continue
            if status_res.status_code >= 400:
                continue
            status = status_res.json().get("status")
            if status in ("approved", "denied"):
                return {"status": status, "request_token": token}

        return {"status": "pending", "request_token": token}

    # -- transport ---------------------------------------------------------

    def sign_jwt(self) -> str:
        """Mint a short-lived RS256 assertion of this agent's identity."""
        return sign_jwt(self.agent_id, self.owner_id, self._private_key)

    def _authed_request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        url = f"{self.proxy_url}{path}"

        def once() -> httpx.Response:
            token = self.sign_jwt()
            try:
                return self._http.request(
                    method,
                    url,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "application/json",
                    },
                    timeout=self._timeout_s,
                    **kwargs,
                )
            except httpx.HTTPError as err:
                raise NetworkError(diagnose_network_error(err, self.proxy_url), err) from err

        response = once()
        # Retry once on 401 — the assertion may have been minted either side of
        # a clock-skew boundary. Same one-shot retry as the Node SDK.
        return once() if response.status_code == 401 else response

    def _get_json(self, path: str) -> Any:
        response = self._authed_request("GET", path)
        if response.status_code >= 400:
            raise ProxyError(response.status_code, response.text)
        return try_parse_json(response.text)
