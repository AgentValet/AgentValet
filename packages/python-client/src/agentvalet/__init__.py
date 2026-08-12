"""agentvalet — call approved SaaS platforms from any Python agent.

Your agent never holds the downstream credential. This client signs a
short-lived RS256 identity assertion; the AgentValet broker checks it against
the owner's grants and policy, injects the credential at call time, and writes
an audit record.

    from agentvalet import AgentValet

    av = AgentValet.from_env()
    av.call(
        platform="slack",
        endpoint="/api/chat.postMessage",
        method="POST",
        scope="chat:write",
        data={"channel": "#general", "text": "Deploy finished."},
    )

Use :class:`agentvalet.aio.AsyncAgentValet` for the async equivalent.
"""

from __future__ import annotations

from ._constants import DEFAULT_PROXY_URL
from .aio import AsyncAgentValet
from .client import AgentValet
from .errors import (
    AccessDeniedError,
    AgentValetError,
    ApprovalDeniedError,
    ApprovalExpiredError,
    ApprovalTimeoutError,
    ConfigError,
    NetworkError,
    ProxyError,
    UpstreamError,
)

__version__ = "0.1.0"

__all__ = [
    "DEFAULT_PROXY_URL",
    "AccessDeniedError",
    "AgentValet",
    "AgentValetError",
    "ApprovalDeniedError",
    "ApprovalExpiredError",
    "ApprovalTimeoutError",
    "AsyncAgentValet",
    "ConfigError",
    "NetworkError",
    "ProxyError",
    "UpstreamError",
    "__version__",
]
