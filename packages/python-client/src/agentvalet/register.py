"""``agentvalet register`` — bind this machine to an agent, Node-free.

Deliberately implements ONLY the bind path (``POST /v1/invites/bind``), where
the private key is generated **here** and the server receives nothing but the
SPKI public key. The older self-serve ``/v1/register`` flow has the server
generate the keypair and hand the PEM back over the wire once; adding a second
consumer of that exposure window in a brand-new SDK would be a regression, so
this command does not offer it.

That means you need a code to bind against — either an invite's ``bind_secret``
or the enrollment code from the "Try it free" flow (they are the same value;
the enrollment code IS the pre-claimed invite's bind secret).

Writes the same files as the Node CLI, so the two are interchangeable:
  ~/.agentvalet/agent.key   private key, mode 0600
  ~/.agentvalet/config.json agent id / owner id / api url / key path
"""

from __future__ import annotations

import argparse
import json
import os
import stat
import sys
from pathlib import Path
from typing import Any

import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from ._constants import DEFAULT_PROXY_URL, REQUEST_TIMEOUT_S
from .env import proxy_url_from_env

AGENT_DIR = Path.home() / ".agentvalet"
AGENT_KEY_PATH = AGENT_DIR / "agent.key"
CONFIG_PATH = AGENT_DIR / "config.json"

RSA_KEY_SIZE = 2048


def generate_keypair() -> tuple[str, str]:
    """Return ``(private_pkcs8_pem, public_spki_pem)``. Never leaves this process."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=RSA_KEY_SIZE)
    private_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")
    public_pem = (
        key.public_key()
        .public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        .decode("utf-8")
    )
    return private_pem, public_pem


def bind(
    code: str,
    proxy_url: str = DEFAULT_PROXY_URL,
    transport: httpx.Client | None = None,
) -> dict[str, Any]:
    """Generate a keypair locally and bind it to the agent behind ``code``.

    Returns the saved identity. Raises ``httpx.HTTPStatusError`` with the
    proxy's message on a rejected bind (expired code, already bound, wrong
    invite state) — those are all user-actionable and worth surfacing verbatim.
    """
    private_pem, public_pem = generate_keypair()

    client = transport or httpx.Client(timeout=REQUEST_TIMEOUT_S)
    try:
        response = client.post(
            f"{proxy_url.rstrip('/')}/v1/invites/bind",
            json={"bind_secret": code, "public_key_pem": public_pem},
            headers={"Content-Type": "application/json"},
        )
    finally:
        if transport is None:
            client.close()

    if response.status_code >= 400:
        detail = _error_text(response)
        raise httpx.HTTPStatusError(detail, request=response.request, response=response)

    result = response.json()
    identity = {
        "agentId": result["agent_id"],
        "ownerId": result["owner_id"],
        "apiUrl": result.get("proxy_url", proxy_url),
        "status": result.get("status"),
    }
    save_identity(identity, private_pem)
    return identity


def save_identity(identity: dict[str, Any], private_pem: str) -> Path:
    """Persist key + config in the layout the Node CLI also reads and writes."""
    AGENT_DIR.mkdir(parents=True, exist_ok=True)

    AGENT_KEY_PATH.write_text(private_pem, encoding="utf-8")
    # Best-effort on Windows, where POSIX modes are advisory.
    try:
        os.chmod(AGENT_KEY_PATH, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass

    existing: dict[str, Any] = {}
    if CONFIG_PATH.exists():
        try:
            existing = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except ValueError:
            existing = {}

    existing.update(
        {
            "agentId": identity["agentId"],
            "ownerId": identity["ownerId"],
            "apiUrl": identity["apiUrl"],
            "keyPath": str(AGENT_KEY_PATH),
            # Legacy field names the Node CLI still reads.
            "lastAgentId": identity["agentId"],
            "lastKeyPath": str(AGENT_KEY_PATH),
        }
    )
    CONFIG_PATH.write_text(json.dumps(existing, indent=2), encoding="utf-8")
    return AGENT_KEY_PATH


def _error_text(response: httpx.Response) -> str:
    try:
        payload = response.json()
        if isinstance(payload, dict):
            return str(payload.get("error") or payload)
    except ValueError:
        pass
    return response.text or f"HTTP {response.status_code}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="agentvalet", description="AgentValet agent tools")
    sub = parser.add_subparsers(dest="command", required=True)

    reg = sub.add_parser(
        "register",
        help="Bind this machine to an agent using an invite or enrollment code",
    )
    reg.add_argument(
        "--code",
        required=True,
        help="Invite bind_secret or 'Try it free' enrollment code",
    )
    reg.add_argument("--proxy-url", default=None, help=f"Defaults to {DEFAULT_PROXY_URL}")

    args = parser.parse_args(argv)

    if args.command == "register":
        proxy_url = args.proxy_url or proxy_url_from_env()
        try:
            identity = bind(args.code, proxy_url=proxy_url)
        except httpx.HTTPStatusError as err:
            print(f"Registration failed: {err}", file=sys.stderr)
            return 1
        except httpx.HTTPError as err:
            print(f"Could not reach {proxy_url}: {err}", file=sys.stderr)
            return 1

        print(f"Bound agent {identity['agentId']}")
        print(f"  owner:    {identity['ownerId']}")
        print(f"  proxy:    {identity['apiUrl']}")
        print(f"  key:      {AGENT_KEY_PATH}  (private key never left this machine)")
        print("\nYou can now use AgentValet.from_env() with no further configuration.")
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
