"""Key-rotation pool: each call starts from the next key; the rest are fallbacks."""

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from apps.server.app.config import Tier1Config, Tier2Config
from apps.server.app.providers.judges.factory import (
    _is_local_url,
    _validate_api_url,
    create_tier1_judge_provider,
    create_tier2_judge_provider,
)
from apps.server.app.providers.judges.ollama_chat import OllamaChatJudgeProvider
from apps.server.app.providers.judges.openai_compatible import OpenAICompatibleJudgeProvider

MODELS_YAML = """
gemma4:
  api_url: "https://ollama.com/api/chat"
  api_style: "ollama"
  ollama_model: "gemma4:e4b"
ollama_cloud_gemma4_31b:
  api_url: "https://ollama.com/api/chat"
  api_style: "ollama"
  ollama_model: "gemma4:31b"
"""


class OrderedApiKeysTest(unittest.TestCase):
    def test_pool_rotates_start_key_per_call(self) -> None:
        provider = OllamaChatJudgeProvider(
            api_url="https://ollama.com/api/chat",
            api_key="k1",
            model="m",
            api_keys=("k1", "k2", "k3"),
        )
        from apps.server.app.providers.judges.base import ordered_api_keys

        orders = [
            ordered_api_keys(provider.api_keys, provider.api_key, provider.fallback_api_key, provider._rotation)
            for _ in range(4)
        ]
        self.assertEqual(orders[0], ["k1", "k2", "k3"])
        self.assertEqual(orders[1], ["k2", "k3", "k1"])
        self.assertEqual(orders[2], ["k3", "k1", "k2"])
        self.assertEqual(orders[3], ["k1", "k2", "k3"])  # wraps around

    def test_without_pool_order_is_fixed_primary_then_fallback(self) -> None:
        provider = OpenAICompatibleJudgeProvider(
            base_url="https://api.example.com/v1",
            api_key="primary",
            model="m",
            fallback_api_key="backup",
        )
        from apps.server.app.providers.judges.base import ordered_api_keys

        for _ in range(3):
            order = ordered_api_keys(
                provider.api_keys, provider.api_key, provider.fallback_api_key, provider._rotation
            )
            self.assertEqual(order, ["primary", "backup"])

    def test_single_key_pool_never_rotates(self) -> None:
        from itertools import count

        from apps.server.app.providers.judges.base import ordered_api_keys

        rotation = count()
        self.assertEqual(ordered_api_keys(("only",), "only", None, rotation), ["only"])
        self.assertEqual(next(rotation), 0)  # rotation untouched for single-key pools


class FactoryPoolResolutionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.models_file = Path(self.tmpdir.name) / "models.local.yaml"
        self.models_file.write_text(MODELS_YAML, encoding="utf-8")

    def tearDown(self) -> None:
        self.tmpdir.cleanup()

    def _tier1_config(self) -> Tier1Config:
        return Tier1Config(
            provider="experiment",
            api_key_env="ollama1",
            fallback_api_key_env="ollama3",
            api_key_pool_envs=["ollama1", "ollama3", "ollama2"],
            experiment_models_file=str(self.models_file),
            experiment_model_key="gemma4",
        )

    def test_pool_resolves_in_configured_order(self) -> None:
        env = {"ollama1": "key-a", "ollama2": "key-b", "ollama3": "key-c"}
        with mock.patch.dict(os.environ, env, clear=False):
            provider = create_tier1_judge_provider(self._tier1_config())
        assert provider is not None
        self.assertEqual(provider.api_keys, ("key-a", "key-c", "key-b"))

    def test_missing_pool_keys_degrade_to_primary_fallback(self) -> None:
        env = {"ollama1": "key-a", "ollama2": "", "ollama3": ""}
        with mock.patch.dict(os.environ, env, clear=False):
            provider = create_tier1_judge_provider(self._tier1_config())
        assert provider is not None
        self.assertIsNone(provider.api_keys)  # < 2 resolved keys → no rotation
        self.assertEqual(provider.api_key, "key-a")

    def test_tier2_pool_uses_its_own_order(self) -> None:
        config = Tier2Config(
            provider="experiment",
            api_key_env="ollama2",
            fallback_api_key_env="ollama3",
            api_key_pool_envs=["ollama2", "ollama3", "ollama1"],
            experiment_models_file=str(self.models_file),
            experiment_model_key="ollama_cloud_gemma4_31b",
        )
        env = {"ollama1": "key-a", "ollama2": "key-b", "ollama3": "key-c"}
        with mock.patch.dict(os.environ, env, clear=False):
            provider = create_tier2_judge_provider(config)
        assert provider is not None
        self.assertEqual(provider.api_keys, ("key-b", "key-c", "key-a"))


class ProviderUrlSecurityTest(unittest.TestCase):
    def test_recognizes_only_exact_loopback_hosts(self) -> None:
        self.assertTrue(_is_local_url("http://localhost:11434/api/chat"))
        self.assertTrue(_is_local_url("http://127.0.0.1:11434/api/chat"))
        self.assertTrue(_is_local_url("http://[::1]:11434/api/chat"))
        self.assertFalse(_is_local_url("https://localhost.attacker.example/api/chat"))
        self.assertFalse(_is_local_url("https://example.com/?next=http://127.0.0.1"))

    def test_requires_https_for_non_loopback_provider(self) -> None:
        with self.assertRaisesRegex(ValueError, "must use HTTPS"):
            _validate_api_url("http://api.example.com/v1/chat")

        self.assertEqual(
            _validate_api_url("https://api.example.com/v1/chat"),
            "https://api.example.com/v1/chat",
        )


if __name__ == "__main__":
    unittest.main()
