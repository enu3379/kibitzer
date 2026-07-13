from __future__ import annotations

import math
import tempfile
import unittest
from pathlib import Path

from apps.server.app.config import EmbeddingConfig
from apps.server.app.providers.embeddings.factory import create_embedding_provider
from apps.server.app.providers.embeddings.onnx_cpu import OnnxCpuEmbeddingProvider


class OnnxCpuEmbeddingProviderTest(unittest.TestCase):
    def test_embed_sync_chunks_inputs_by_batch_size(self) -> None:
        provider = OnnxCpuEmbeddingProvider(
            model_path="unused.onnx",
            tokenizer_path="unused-tokenizer.json",
            dimensions=3,
            batch_size=2,
        )
        batches: list[list[str]] = []
        provider._ensure_loaded = lambda: None  # type: ignore[method-assign]

        def fake_embed_batch(texts: list[str]) -> list[list[float]]:
            batches.append(texts)
            return [[1.0, 0.0, 0.0] for _ in texts]

        provider._embed_batch = fake_embed_batch  # type: ignore[method-assign]

        vectors = provider._embed_sync(["first", "second", "third"])

        self.assertEqual(batches, [["first", "second"], ["third"]])
        self.assertEqual(len(vectors), 3)

    def test_single_item_batching_is_independent_of_caller_grouping(self) -> None:
        provider = OnnxCpuEmbeddingProvider(
            model_path="unused.onnx",
            tokenizer_path="unused-tokenizer.json",
            dimensions=2,
            batch_size=1,
        )
        batches: list[list[str]] = []
        provider._ensure_loaded = lambda: None  # type: ignore[method-assign]

        def fake_embed_batch(texts: list[str]) -> list[list[float]]:
            batches.append(texts)
            return [[1.0, 0.0]]

        provider._embed_batch = fake_embed_batch  # type: ignore[method-assign]

        provider._embed_sync(["anchor", "first title", "second title"])

        self.assertEqual(batches, [["anchor"], ["first title"], ["second title"]])

    def test_prepare_adds_query_prefix_and_normalizes_whitespace(self) -> None:
        provider = OnnxCpuEmbeddingProvider(
            model_path="unused.onnx",
            tokenizer_path="unused-tokenizer.json",
        )

        self.assertEqual(provider._prepare("  국내   여행지  "), "query: 국내 여행지")

    def test_validate_vector_normalizes_and_rejects_bad_values(self) -> None:
        provider = OnnxCpuEmbeddingProvider(
            model_path="unused.onnx",
            tokenizer_path="unused-tokenizer.json",
            dimensions=2,
        )

        vector = provider._validate_vector([3.0, 4.0], 0)

        self.assertAlmostEqual(math.sqrt(sum(value * value for value in vector)), 1.0)
        self.assertEqual(vector, [0.6, 0.8])
        with self.assertRaisesRegex(RuntimeError, "dimension 1; expected 2"):
            provider._validate_vector([1.0], 0)
        with self.assertRaisesRegex(RuntimeError, "non-finite"):
            provider._validate_vector([math.inf, 1.0], 0)
        with self.assertRaisesRegex(RuntimeError, "zero vector"):
            provider._validate_vector([0.0, 0.0], 0)

    def test_missing_model_fails_explicitly(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            provider = OnnxCpuEmbeddingProvider(
                model_path=str(Path(tmpdir) / "missing.onnx"),
                tokenizer_path=str(Path(tmpdir) / "missing-tokenizer.json"),
            )

            with self.assertRaisesRegex(RuntimeError, "ONNX embedding model not found"):
                provider._embed_sync(["title"])

    def test_factory_creates_onnx_provider_without_loading_model(self) -> None:
        provider = create_embedding_provider(
            EmbeddingConfig(
                provider="onnx_cpu",
                model="model.onnx",
                tokenizer_path="tokenizer.json",
                dimensions=384,
                max_length=128,
            )
        )

        self.assertIsInstance(provider, OnnxCpuEmbeddingProvider)
        self.assertEqual(provider.model_path, "model.onnx")
        self.assertEqual(provider.tokenizer_path, "tokenizer.json")


if __name__ == "__main__":
    unittest.main()
