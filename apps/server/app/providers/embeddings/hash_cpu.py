from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass


TOKEN_RE = re.compile(r"[0-9A-Za-z가-힣_]+")
CJK_RE = re.compile(r"[가-힣]")


@dataclass(frozen=True)
class HashCpuEmbeddingProvider:
    dimensions: int = 256
    normalize: bool = True

    async def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._embed_one(text) for text in texts]

    def _embed_one(self, text: str) -> list[float]:
        vector = [0.0] * self.dimensions
        for token in TOKEN_RE.findall(text.lower()):
            for unit in self._units(token):
                digest = hashlib.blake2b(unit.encode("utf-8"), digest_size=8).digest()
                index = int.from_bytes(digest[:4], "big") % self.dimensions
                sign = 1.0 if digest[4] % 2 == 0 else -1.0
                vector[index] += sign

        if self.normalize:
            norm = math.sqrt(sum(value * value for value in vector))
            if norm:
                vector = [value / norm for value in vector]
        return vector

    def _units(self, token: str) -> list[str]:
        # Hangul is agglutinative and spacing varies ("크리에이트모드" vs "크리에이트 모드"),
        # so whole-token hashing alone misses obviously related titles. Character bigrams
        # give partial overlap while staying deterministic and CPU-only.
        units = [token]
        if CJK_RE.search(token) and len(token) >= 2:
            units.extend(token[i : i + 2] for i in range(len(token) - 1))
        return units
