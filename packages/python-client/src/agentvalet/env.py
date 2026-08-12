"""Environment resolution for ``AgentValet.from_env()``.

Ported from ``packages/client/src/env.ts``. Accepts BOTH naming conventions
already in the wild: the bare names the Node CLI and MCPB write
(``AGENT_ID``, ``OWNER_ID``, ``PROXY_URL``, ``AGENT_PRIVATE_KEY*``) and
``AGENTVALET_``-prefixed aliases, which is what the docs tell people to set.

A machine that has run ``agentvalet register`` (or ``npx @agentvalet/register``)
already satisfies the bare set, so ``from_env()`` works with no extra config.
That property is the single most important onboarding affordance in the package
— do not "tidy" it into one canonical name.
"""

from __future__ import annotations

import base64
import os
from pathlib import Path

from ._constants import DEFAULT_PROXY_URL
from .errors import ConfigError

__all__ = ["agent_id_from_env", "owner_id_from_env", "private_key_from_env", "proxy_url_from_env"]

#: Written by the register flow. Also read by the Node SDK and mcp-server.
KEY_PATH = Path.home() / ".agentvalet" / "agent.key"


def _read_env(name: str) -> str | None:
    """Empty strings and unresolved MCPB placeholders count as not-set.

    The MCPB writes a literal ``${user_config.foo}`` when a field is left
    blank. Treating that as a real value produces a baffling 401 much later,
    far from the actual mistake.
    """
    raw = os.environ.get(name)
    if raw is None:
        return None
    value = raw.strip()
    if not value:
        return None
    if value.startswith("${") and value.endswith("}"):
        return None
    return value


def _read_either(suffix: str) -> str | None:
    """``AGENTVALET_``-prefixed name wins over the bare name when both are set."""
    return _read_env(f"AGENTVALET_{suffix}") or _read_env(suffix)


def agent_id_from_env() -> str | None:
    return _read_either("AGENT_ID")


def owner_id_from_env() -> str | None:
    return _read_either("OWNER_ID")


def proxy_url_from_env() -> str:
    return (_read_either("PROXY_URL") or DEFAULT_PROXY_URL).rstrip("/")


def private_key_from_env() -> str:
    """Resolve the RS256 private key PEM.

    Precedence, matching the Node SDK exactly:

    1. ``AGENT_PRIVATE_KEY_B64``  — base64-encoded PEM (12-factor / container safe)
    2. ``AGENT_PRIVATE_KEY_PATH`` — path to a PEM file
    3. ``AGENT_PRIVATE_KEY``      — raw multi-line PEM, or ``\\n``-escaped single line
    4. ``~/.agentvalet/agent.key`` — written by the register flow
    """
    b64 = _read_either("AGENT_PRIVATE_KEY_B64")
    if b64:
        return base64.b64decode(b64).decode("utf-8").strip()

    path = _read_either("AGENT_PRIVATE_KEY_PATH")
    if path:
        try:
            return Path(path).read_text(encoding="utf-8").strip()
        except OSError as err:
            raise ConfigError(f"Cannot read AGENT_PRIVATE_KEY_PATH ({path}): {err}") from err

    raw = _read_either("AGENT_PRIVATE_KEY")
    if raw:
        unescaped = raw.replace("\\n", "\n")
        # Secrets UIs routinely trim the PEM armour on paste. Re-wrap rather
        # than failing deep inside the crypto layer with an opaque message.
        if not unescaped.startswith("-----"):
            return f"-----BEGIN PRIVATE KEY-----\n{unescaped}\n-----END PRIVATE KEY-----"
        return unescaped

    disk = _read_disk_key()
    if disk:
        return disk

    raise ConfigError(
        "No private key found. Set AGENT_PRIVATE_KEY, AGENT_PRIVATE_KEY_PATH, or "
        "AGENT_PRIVATE_KEY_B64, or run `agentvalet register` to create an agent and "
        "write ~/.agentvalet/agent.key."
    )


def _read_disk_key() -> str | None:
    try:
        return KEY_PATH.read_text(encoding="utf-8").strip() or None
    except OSError:
        return None
