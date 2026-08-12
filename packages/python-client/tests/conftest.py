"""Shared fixtures.

The important one is ``client``: it is parametrized over the sync and async
classes, and :func:`invoke` awaits only when needed. Every behaviour test
therefore runs twice, against both implementations, from one test body. That is
what stops :mod:`agentvalet.aio` silently drifting from
:mod:`agentvalet.client`.
"""

import inspect
from typing import Any

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from agentvalet import AgentValet, AsyncAgentValet

PROXY = "https://api.example.test"


@pytest.fixture(scope="session")
def private_key_pem() -> str:
    """One 2048-bit key for the whole session — keygen is slow."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")


@pytest.fixture(params=["sync", "async"])
def make_client(request: pytest.FixtureRequest, private_key_pem: str):
    """Factory producing either implementation with test-speed timings."""
    cls = AgentValet if request.param == "sync" else AsyncAgentValet

    def factory(**overrides: Any):
        kwargs: dict = {
            "agent_id": "agt_test",
            "owner_id": "own_test",
            "private_key": private_key_pem,
            "proxy_url": PROXY,
            "approval_poll_s": 0.001,
            "approval_timeout_s": 0.5,
        }
        kwargs.update(overrides)
        return cls(**kwargs)

    factory.kind = request.param  # type: ignore[attr-defined]
    factory.cls = cls  # type: ignore[attr-defined]
    return factory


@pytest.fixture
def client(make_client):
    return make_client()


async def invoke(target: Any, name: str, /, *args: Any, **kwargs: Any) -> Any:
    """Call method ``name`` on either client, awaiting only the async one.

    Both parameters are positional-only so a forwarded kwarg (``method="POST"``)
    can't collide with this signature.
    """
    result = getattr(target, name)(*args, **kwargs)
    if inspect.isawaitable(result):
        return await result
    return result
