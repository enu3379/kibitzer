"""Key-rotation pool: each call starts from the next key; the rest are fallbacks."""

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from apps.server.app.config import Tier1Config, Tier2Config
from apps.server.app.providers.judges.factory import (
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

    def _tier1_edge_config(self, provider: str) -> Tier1Config:
        return Tier1Config(
            provider=provider,
            base_url="https://api.example.com/v1",
            api_key_env="tier1_primary",
            fallback_api_key_env="tier1_fallback",
            api_key_pool_envs=[
                "tier1_pool_1",
                "tier1_pool_2",
                "tier1_pool_3",
            ],
            model="direct-model",
            experiment_models_file=str(self.models_file),
            experiment_model_key="gemma4",
        )

    def _tier2_config(self) -> Tier2Config:
        return Tier2Config(
            provider="experiment",
            api_key_env="ollama2",
            fallback_api_key_env="ollama3",
            api_key_pool_envs=["ollama2", "ollama3", "ollama1"],
            experiment_models_file=str(self.models_file),
            experiment_model_key="ollama_cloud_gemma4_31b",
        )

    def test_pool_resolves_in_configured_order(self) -> None:
        env = {"ollama1": "key-a", "ollama2": "key-b", "ollama3": "key-c"}
        with mock.patch.dict(os.environ, env, clear=False):
            provider = create_tier1_judge_provider(self._tier1_config())
        assert provider is not None
        self.assertEqual(provider.api_keys, ("key-a", "key-c", "key-b"))

    def test_direct_tier1_resolves_fallback_and_pool(self) -> None:
        env = {
            "tier1_primary": "key-a",
            "tier1_fallback": "key-c",
            "tier1_pool_1": "key-a",
            "tier1_pool_2": "key-c",
            "tier1_pool_3": "key-b",
        }
        with mock.patch.dict(os.environ, env, clear=True):
            provider = create_tier1_judge_provider(
                self._tier1_edge_config("openai_compatible")
            )
        assert provider is not None
        self.assertEqual(provider.fallback_api_key, "key-c")
        self.assertEqual(provider.api_keys, ("key-a", "key-c", "key-b"))

    def test_direct_and_experiment_tier1_share_pool_edge_cases(self) -> None:
        cases = [
            (
                "empty_pool",
                {"tier1_primary": "primary", "tier1_fallback": "backup"},
                ("primary", "backup", None),
            ),
            (
                "single_pool_key",
                {"tier1_pool_2": "only"},
                ("only", None, None),
            ),
            (
                "duplicate_pool_keys",
                {
                    "tier1_primary": "primary",
                    "tier1_fallback": "backup",
                    "tier1_pool_1": "duplicate",
                    "tier1_pool_2": "duplicate",
                },
                ("primary", "backup", ("duplicate", "duplicate")),
            ),
        ]
        for name, env, expected in cases:
            with self.subTest(name=name), mock.patch.dict(os.environ, env, clear=True):
                direct = create_tier1_judge_provider(
                    self._tier1_edge_config("openai_compatible")
                )
                experiment = create_tier1_judge_provider(
                    self._tier1_edge_config("experiment")
                )
            assert direct is not None
            assert experiment is not None
            direct_keys = (direct.api_key, direct.fallback_api_key, direct.api_keys)
            experiment_keys = (
                experiment.api_key,
                experiment.fallback_api_key,
                experiment.api_keys,
            )
            self.assertEqual(direct_keys, expected)
            self.assertEqual(experiment_keys, expected)

    def test_missing_pool_keys_degrade_to_primary_fallback(self) -> None:
        env = {"ollama1": "key-a", "ollama2": "", "ollama3": ""}
        with mock.patch.dict(os.environ, env, clear=False):
            provider = create_tier1_judge_provider(self._tier1_config())
        assert provider is not None
        self.assertIsNone(provider.api_keys)  # < 2 resolved keys → no rotation
        self.assertEqual(provider.api_key, "key-a")

    def test_tier1_uses_only_available_pool_key(self) -> None:
        env = {"ollama1": "", "ollama2": "key-b", "ollama3": ""}
        with mock.patch.dict(os.environ, env, clear=False):
            provider = create_tier1_judge_provider(self._tier1_config())
        assert provider is not None
        self.assertEqual(provider.api_key, "key-b")
        self.assertIsNone(provider.api_keys)

    def test_tier2_uses_only_available_pool_key(self) -> None:
        env = {"ollama1": "key-a", "ollama2": "", "ollama3": ""}
        with mock.patch.dict(os.environ, env, clear=False):
            provider = create_tier2_judge_provider(self._tier2_config())
        assert provider is not None
        self.assertEqual(provider.api_key, "key-a")
        self.assertIsNone(provider.api_keys)

    def test_tier2_pool_uses_its_own_order(self) -> None:
        env = {"ollama1": "key-a", "ollama2": "key-b", "ollama3": "key-c"}
        with mock.patch.dict(os.environ, env, clear=False):
            provider = create_tier2_judge_provider(self._tier2_config())
        assert provider is not None
        self.assertEqual(provider.api_keys, ("key-b", "key-c", "key-a"))


if __name__ == "__main__":
    unittest.main()
