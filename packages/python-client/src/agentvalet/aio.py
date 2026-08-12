"""Asynchronous AgentValet client.

A method-for-method mirror of :class:`agentvalet.client.AgentValet`. All the
decision logic lives in :mod:`agentvalet._protocol`, which both clients share,
so the only thing that differs here is the transport and the awaits. The test
suite runs the same behaviour table against both classes to keep it that way.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable
from typing import Any, Callable, Union

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

__all__ = ["AsyncAgentValet"]

AsyncProgressCallback = Callable[[dict[str, Any]], Union[Awaitable[None], None]]


class AsyncAgentValet:
    """Async twin of :class:`agentvalet.client.AgentValet`."""

    def __init__(
        self,
        agent_id: str,
        owner_id: str,
        private_key: str,
        proxy_url: str = DEFAULT_PROXY_URL,
        timeout_s: float = REQUEST_TIMEOUT_S,
        approval_timeout_s: float = APPROVAL_TIMEOUT_S,
        approval_poll_s: float = APPROVAL_POLL_S,
        on_approval_pending: AsyncProgressCallback | None = None,
        transport: httpx.AsyncClient | None = None,
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
        self._http = transport or httpx.AsyncClient(timeout=timeout_s)

    @classmethod
    def from_env(cls, **overrides: Any) -> AsyncAgentValet:
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

    async def __aenter__(self) -> AsyncAgentValet:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owns_client:
            await self._http.aclose()

    # -- core --------------------------------------------------------------

    async def call(
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
        """See :meth:`agentvalet.client.AgentValet.call`."""
        body = build_action_body(
            platform=platform,
            endpoint=endpoint,
            scope=scope,
            method=method,
            data=data,
            connection_id=connection_id,
            reason=reason,
        )
        response = await self._authed_request("POST", "/v1/actions", json=body)
        text = response.text

        if response.status_code == 202:
            approval_id = approval_id_from_202(text)
            if approval_id:
                return await self.wait_for_approval(
                    approval_id,
                    platform=platform,
                    scope=scope,
                    endpoint=endpoint,
                    timeout_s=approval_timeout_s,
                )

        return interpret_action_response(response.status_code, text, platform, scope)

    async def wait_for_approval(
        self,
        approval_id: str,
        platform: str = "",
        scope: str = "",
        endpoint: str = "",
        timeout_s: float | None = None,
    ) -> Any:
        """See :meth:`agentvalet.client.AgentValet.wait_for_approval`."""
        budget = self._approval_timeout_s if timeout_s is None else timeout_s
        started = time.monotonic()

        while time.monotonic() - started < budget:
            await asyncio.sleep(self._approval_poll_s)
            elapsed = time.monotonic() - started

            try:
                response = await self._authed_request("GET", f"/v1/approvals/{approval_id}")
            except NetworkError:
                continue

            if response.status_code >= 400:
                raise ProxyError(response.status_code, response.text)

            done, value = interpret_approval_status(response.json(), approval_id)
            if done:
                return value

            if self._on_approval_pending:
                maybe = self._on_approval_pending(
                    {
                        "approval_id": approval_id,
                        "elapsed_s": elapsed,
                        "platform": platform,
                        "scope": scope,
                        "endpoint": endpoint,
                    }
                )
                # Accept either a plain callback or a coroutine function.
                if asyncio.iscoroutine(maybe):
                    await maybe

        raise ApprovalTimeoutError(approval_id, budget)

    # -- discovery / governance -------------------------------------------

    async def list_platforms(self) -> Any:
        return await self._get_json("/v1/agent/permissions")

    async def pending_actions(self) -> Any:
        return await self._get_json("/v1/agents/me/pending-actions")

    async def evaluate(self, platform: str, scope: str) -> Any:
        response = await self._authed_request(
            "POST", "/v1/authzen/access", json=authzen_body(self.agent_id, platform, scope)
        )
        if response.status_code >= 400:
            raise ProxyError(response.status_code, response.text)
        return try_parse_json(response.text)

    async def request_access(
        self,
        platform: str,
        scope: str | None = None,
        reason: str | None = None,
        timeout_s: float | None = None,
    ) -> dict[str, str]:
        submit = await self._authed_request(
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
            await asyncio.sleep(self._approval_poll_s)
            try:
                status_res = await self._authed_request("GET", f"/v1/access-request/status/{token}")
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
        return sign_jwt(self.agent_id, self.owner_id, self._private_key)

    async def _authed_request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        url = f"{self.proxy_url}{path}"

        async def once() -> httpx.Response:
            token = self.sign_jwt()
            try:
                return await self._http.request(
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

        response = await once()
        return await once() if response.status_code == 401 else response

    async def _get_json(self, path: str) -> Any:
        response = await self._authed_request("GET", path)
        if response.status_code >= 400:
            raise ProxyError(response.status_code, response.text)
        return try_parse_json(response.text)
