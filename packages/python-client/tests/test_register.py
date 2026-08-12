"""Registration binds a locally-generated key. The private half never leaves.

The security property under test is the one the repo already established for
the converged CLI/Desktop bind path: the server never generates, receives,
stores, or logs a private key.
"""

import json

import httpx
import pytest
import respx
from cryptography.hazmat.primitives import serialization

from agentvalet import register

PROXY = "https://api.example.test"


def test_generate_keypair_returns_pkcs8_private_and_spki_public():
    private_pem, public_pem = register.generate_keypair()

    assert private_pem.startswith("-----BEGIN PRIVATE KEY-----")
    assert public_pem.startswith("-----BEGIN PUBLIC KEY-----")
    # The proxy rejects anything that isn't an SPKI PEM (agent-bind.ts:39).
    key = serialization.load_pem_private_key(private_pem.encode(), password=None)
    assert key.key_size == 2048


@respx.mock
def test_bind_posts_only_the_public_key(monkeypatch, tmp_path):
    monkeypatch.setattr(register, "AGENT_DIR", tmp_path)
    monkeypatch.setattr(register, "AGENT_KEY_PATH", tmp_path / "agent.key")
    monkeypatch.setattr(register, "CONFIG_PATH", tmp_path / "config.json")

    route = respx.post(f"{PROXY}/v1/invites/bind").mock(
        return_value=httpx.Response(
            200,
            json={
                "agent_id": "agt_new",
                "owner_id": "own_new",
                "status": "active",
                "proxy_url": "https://api.agentvalet.ai",
            },
        )
    )

    identity = register.bind("bsec_abc", proxy_url=PROXY)

    sent = json.loads(route.calls[0].request.content)
    assert sent["bind_secret"] == "bsec_abc"
    assert sent["public_key_pem"].startswith("-----BEGIN PUBLIC KEY-----")
    # The whole point: no private material on the wire, under any key name.
    assert "PRIVATE KEY" not in route.calls[0].request.content.decode()

    assert identity["agentId"] == "agt_new"
    assert identity["ownerId"] == "own_new"


@respx.mock
def test_bind_persists_key_and_config_in_the_node_cli_layout(monkeypatch, tmp_path):
    monkeypatch.setattr(register, "AGENT_DIR", tmp_path)
    monkeypatch.setattr(register, "AGENT_KEY_PATH", tmp_path / "agent.key")
    monkeypatch.setattr(register, "CONFIG_PATH", tmp_path / "config.json")

    respx.post(f"{PROXY}/v1/invites/bind").mock(
        return_value=httpx.Response(
            200,
            json={"agent_id": "agt_new", "owner_id": "own_new", "status": "active",
                  "proxy_url": "https://api.agentvalet.ai"},
        )
    )

    register.bind("bsec_abc", proxy_url=PROXY)

    key_text = (tmp_path / "agent.key").read_text(encoding="utf-8")
    assert key_text.startswith("-----BEGIN PRIVATE KEY-----")

    config = json.loads((tmp_path / "config.json").read_text(encoding="utf-8"))
    assert config["agentId"] == "agt_new"
    assert config["ownerId"] == "own_new"
    # Legacy names the Node CLI still reads — the two must stay interchangeable.
    assert config["lastAgentId"] == "agt_new"
    assert config["lastKeyPath"] == str(tmp_path / "agent.key")


@respx.mock
def test_bind_preserves_unrelated_config_keys(monkeypatch, tmp_path):
    monkeypatch.setattr(register, "AGENT_DIR", tmp_path)
    monkeypatch.setattr(register, "AGENT_KEY_PATH", tmp_path / "agent.key")
    monkeypatch.setattr(register, "CONFIG_PATH", tmp_path / "config.json")
    (tmp_path / "config.json").write_text(json.dumps({"somethingElse": "keep me"}), encoding="utf-8")

    respx.post(f"{PROXY}/v1/invites/bind").mock(
        return_value=httpx.Response(
            200,
            json={"agent_id": "a", "owner_id": "o", "status": "active", "proxy_url": PROXY},
        )
    )

    register.bind("bsec_abc", proxy_url=PROXY)

    config = json.loads((tmp_path / "config.json").read_text(encoding="utf-8"))
    assert config["somethingElse"] == "keep me"


@respx.mock
def test_rejected_bind_surfaces_the_proxy_message(monkeypatch, tmp_path):
    monkeypatch.setattr(register, "AGENT_KEY_PATH", tmp_path / "agent.key")
    monkeypatch.setattr(register, "CONFIG_PATH", tmp_path / "config.json")

    respx.post(f"{PROXY}/v1/invites/bind").mock(
        return_value=httpx.Response(410, json={"error": "Bind secret expired"})
    )

    with pytest.raises(httpx.HTTPStatusError, match="Bind secret expired"):
        register.bind("bsec_stale", proxy_url=PROXY)

    # A failed bind must not leave a key behind implying success.
    assert not (tmp_path / "agent.key").exists()
