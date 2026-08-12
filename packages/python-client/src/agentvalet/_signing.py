"""RS256 agent assertion minting.

Split out so both clients share it and so the failure mode is one place: a
malformed PEM must surface as :class:`ConfigError`, never as a raw PyJWT or
cryptography traceback that sends the reader looking in the wrong library.
"""

from __future__ import annotations

import time
from typing import Any

import jwt

from ._constants import JWT_ALGORITHM, JWT_LIFETIME_S
from .errors import ConfigError


def sign_jwt(agent_id: str, owner_id: str, private_key_pem: str) -> str:
    now = int(time.time())
    claims: dict[str, Any] = {
        "agent_id": agent_id,
        "owner_id": owner_id,
        "iat": now,
        "exp": now + JWT_LIFETIME_S,
    }
    try:
        return jwt.encode(claims, private_key_pem, algorithm=JWT_ALGORITHM)
    except Exception as err:
        raise ConfigError(
            f"Private key is not a valid RS256 PEM: {err}. Expected a PKCS#8 private key — "
            "run `agentvalet register` to generate one."
        ) from err
