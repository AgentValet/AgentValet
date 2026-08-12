"""Mirrors ``packages/client/tests/env.test.ts``."""

import base64

import pytest

from agentvalet._constants import DEFAULT_PROXY_URL
from agentvalet.env import (
    agent_id_from_env,
    private_key_from_env,
    proxy_url_from_env,
)
from agentvalet.errors import ConfigError

PEM = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----"

ALL_NAMES = [
    "AGENTVALET_AGENT_ID", "AGENT_ID",
    "AGENTVALET_OWNER_ID", "OWNER_ID",
    "AGENTVALET_PROXY_URL", "PROXY_URL",
    "AGENTVALET_AGENT_PRIVATE_KEY", "AGENT_PRIVATE_KEY",
    "AGENTVALET_AGENT_PRIVATE_KEY_B64", "AGENT_PRIVATE_KEY_B64",
    "AGENTVALET_AGENT_PRIVATE_KEY_PATH", "AGENT_PRIVATE_KEY_PATH",
]


@pytest.fixture
def clean_env(monkeypatch):
    """Blank every consulted name so a real env var can't leak into a test."""
    for name in ALL_NAMES:
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


class TestIdentity:
    def test_prefixed_name_wins_over_bare(self, clean_env):
        clean_env.setenv("AGENT_ID", "agt_bare")
        clean_env.setenv("AGENTVALET_AGENT_ID", "agt_prefixed")
        assert agent_id_from_env() == "agt_prefixed"

    def test_falls_back_to_the_bare_name_the_cli_writes(self, clean_env):
        clean_env.setenv("AGENT_ID", "agt_bare")
        assert agent_id_from_env() == "agt_bare"

    def test_unresolved_mcpb_placeholder_counts_as_not_set(self, clean_env):
        # The MCPB writes a literal "${user_config.x}" for a blank field.
        # Accepting it produces a baffling 401 far from the real mistake.
        clean_env.setenv("AGENT_ID", "${user_config.agent_id}")
        assert agent_id_from_env() is None

    def test_proxy_url_defaults_and_strips_trailing_slash(self, clean_env):
        assert proxy_url_from_env() == DEFAULT_PROXY_URL
        clean_env.setenv("PROXY_URL", "https://self.hosted.test/")
        assert proxy_url_from_env() == "https://self.hosted.test"


class TestPrivateKey:
    def test_base64_takes_precedence(self, clean_env):
        clean_env.setenv("AGENT_PRIVATE_KEY_B64", base64.b64encode(PEM.encode()).decode())
        assert private_key_from_env() == PEM

    def test_reads_a_pem_file_by_path(self, clean_env, tmp_path):
        path = tmp_path / "agent.key"
        path.write_text(PEM, encoding="utf-8")
        clean_env.setenv("AGENT_PRIVATE_KEY_PATH", str(path))
        assert private_key_from_env() == PEM

    def test_unreadable_path_raises_config_error_naming_it(self, clean_env, tmp_path):
        missing = tmp_path / "definitely-not-here.key"
        clean_env.setenv("AGENT_PRIVATE_KEY_PATH", str(missing))
        with pytest.raises(ConfigError, match="definitely-not-here"):
            private_key_from_env()

    def test_unescapes_a_collapsed_single_line_pem(self, clean_env):
        clean_env.setenv(
            "AGENT_PRIVATE_KEY",
            "-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----",
        )
        assert private_key_from_env() == PEM

    def test_rewraps_a_blob_that_lost_its_pem_armour(self, clean_env):
        # Secrets UIs routinely trim the delimiters on paste.
        clean_env.setenv("AGENT_PRIVATE_KEY", "AAAA")
        assert private_key_from_env() == PEM
