from __future__ import annotations

from ...config import EmbeddingConfig
from .base import EmbeddingProvider
from .hash_cpu import HashCpuEmbeddingProvider


def create_embedding_provider(config: EmbeddingConfig) -> EmbeddingProvider:
    if config.device != "cpu" or not config.forbid_gpu:
        raise ValueError("Stage 0 embedding must be CPU-only")
    if config.provider in {"hash_cpu", "onnx_cpu"}:
        return HashCpuEmbeddingProvider(dimensions=config.dimensions, normalize=config.normalize)
    raise ValueError(f"unsupported embedding provider: {config.provider}")
