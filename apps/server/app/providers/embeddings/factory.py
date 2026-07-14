from __future__ import annotations

from ...config import EmbeddingConfig
from .base import EmbeddingProvider
from .hash_cpu import HashCpuEmbeddingProvider
from .onnx_cpu import OnnxCpuEmbeddingProvider


def create_embedding_provider(config: EmbeddingConfig) -> EmbeddingProvider:
    if config.device != "cpu" or not config.forbid_gpu:
        raise ValueError("Stage 0 embedding must be CPU-only")
    if config.provider == "hash_cpu":
        return HashCpuEmbeddingProvider(dimensions=config.dimensions, normalize=config.normalize)
    if config.provider == "onnx_cpu":
        if not config.tokenizer_path:
            raise ValueError("onnx_cpu embedding requires tokenizer_path")
        return OnnxCpuEmbeddingProvider(
            model_path=config.model,
            tokenizer_path=config.tokenizer_path,
            dimensions=config.dimensions,
            batch_size=config.batch_size,
            max_length=config.max_length,
            normalize=config.normalize,
        )
    raise ValueError(f"unsupported embedding provider: {config.provider}")
