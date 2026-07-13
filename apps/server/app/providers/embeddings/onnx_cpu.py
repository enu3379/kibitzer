from __future__ import annotations

import asyncio
import math
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class OnnxCpuEmbeddingProvider:
    model_path: str
    tokenizer_path: str
    dimensions: int = 384
    batch_size: int = 8
    max_length: int = 128
    normalize: bool = True
    prefix: str = "query: "
    _session: Any = field(default=None, init=False, repr=False)
    _tokenizer: Any = field(default=None, init=False, repr=False)
    _np: Any = field(default=None, init=False, repr=False)
    _load_lock: threading.Lock = field(default_factory=threading.Lock, init=False, repr=False)

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        return await asyncio.to_thread(self._embed_sync, texts)

    def _embed_sync(self, texts: list[str]) -> list[list[float]]:
        self._ensure_loaded()
        vectors: list[list[float]] = []
        for offset in range(0, len(texts), self.batch_size):
            vectors.extend(self._embed_batch(texts[offset : offset + self.batch_size]))
        return vectors

    def _ensure_loaded(self) -> None:
        if self._session is not None:
            return
        with self._load_lock:
            if self._session is not None:
                return

            model_path = Path(self.model_path)
            tokenizer_path = Path(self.tokenizer_path)
            if not model_path.is_file():
                raise RuntimeError(f"ONNX embedding model not found: {model_path}")
            if not tokenizer_path.is_file():
                raise RuntimeError(f"embedding tokenizer not found: {tokenizer_path}")

            try:
                import numpy as np
                import onnxruntime as ort
                from tokenizers import Tokenizer
            except ImportError as exc:
                raise RuntimeError(
                    "onnx_cpu embedding requires the onnxruntime and tokenizers dependencies"
                ) from exc

            tokenizer = Tokenizer.from_file(str(tokenizer_path))
            tokenizer.enable_truncation(max_length=self.max_length)
            pad_id = tokenizer.token_to_id("<pad>")
            if pad_id is None:
                raise RuntimeError("embedding tokenizer has no <pad> token")
            tokenizer.enable_padding(pad_id=pad_id, pad_token="<pad>")

            session = ort.InferenceSession(
                str(model_path),
                providers=["CPUExecutionProvider"],
            )
            providers = session.get_providers()
            if providers != ["CPUExecutionProvider"]:
                raise RuntimeError(f"ONNX embedding must be CPU-only, got providers: {providers}")

            self._np = np
            self._tokenizer = tokenizer
            self._session = session

    def _embed_batch(self, texts: list[str]) -> list[list[float]]:
        prepared = [self._prepare(text) for text in texts]
        encodings = self._tokenizer.encode_batch(prepared)
        np = self._np
        input_names = {item.name for item in self._session.get_inputs()}

        input_ids = np.asarray([item.ids for item in encodings], dtype=np.int64)
        attention_mask = np.asarray(
            [item.attention_mask for item in encodings],
            dtype=np.int64,
        )
        inputs = {
            "input_ids": input_ids,
            "attention_mask": attention_mask,
        }
        if "token_type_ids" in input_names:
            inputs["token_type_ids"] = np.asarray(
                [item.type_ids for item in encodings],
                dtype=np.int64,
            )

        output = self._session.run(None, inputs)
        if not output:
            raise RuntimeError("ONNX embedding model returned no outputs")
        hidden = np.asarray(output[0])
        expected_shape = (len(texts), input_ids.shape[1], self.dimensions)
        if hidden.shape != expected_shape:
            raise RuntimeError(
                f"ONNX hidden state has shape {hidden.shape}; expected {expected_shape}"
            )

        mask = attention_mask[..., None].astype(np.float32)
        token_counts = mask.sum(axis=1)
        pooled = (hidden * mask).sum(axis=1) / token_counts
        return [self._validate_vector(vector, index) for index, vector in enumerate(pooled)]

    def _prepare(self, text: str) -> str:
        return f"{self.prefix}{' '.join(text.split())}"

    def _validate_vector(self, value: Any, index: int) -> list[float]:
        vector = [float(component) for component in value]
        if len(vector) != self.dimensions:
            raise RuntimeError(
                f"ONNX embedding {index} has dimension {len(vector)}; expected {self.dimensions}"
            )
        if not all(math.isfinite(component) for component in vector):
            raise RuntimeError(f"ONNX embedding {index} contains non-finite values")

        norm = math.sqrt(sum(component * component for component in vector))
        if norm == 0.0:
            raise RuntimeError(f"ONNX embedding {index} is a zero vector")
        if self.normalize:
            vector = [component / norm for component in vector]
        return vector
