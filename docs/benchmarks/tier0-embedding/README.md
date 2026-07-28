# Extending the Tier 0 Embedding Benchmark

This benchmark is a reusable comparison harness, not an ONNX-only test. It
keeps the 200 labeled anchor-title pairs and evaluation policy fixed while
allowing any embedding implementation that satisfies the method contract below.

The current committed result is in [`report.md`](report.md). The source dataset
and its model-independent construction rules are in:

- `scripts/fixtures/tier0_embedding_benchmark_dataset.json`
- `scripts/fixtures/tier0_embedding_benchmark_guidelines.md`

## Method Contract

An external method is loaded through a synchronous factory:

```python
def create_benchmark_provider(config: AppConfig) -> EmbeddingProvider:
    return MyEmbeddingProvider(...)
```

The returned object must implement the existing application protocol:

```python
class EmbeddingProvider(Protocol):
    async def embed(self, texts: list[str]) -> list[list[float]]:
        ...
```

Provider requirements:

1. Return exactly one vector per input, in input order.
2. Use one fixed, non-zero dimension within the method. Different methods may
   use different dimensions.
3. Return only finite numeric values and no zero vectors.
4. Produce stable embeddings: each input's cold/warm vectors must have cosine
   similarity of at least `0.999`.
5. Higher cosine similarity must mean stronger semantic relevance.

The runner mechanically checks vector count, dimensions, finite/non-zero
values, and cold/warm stability. It cannot detect reordered-but-shape-correct
vectors or verify semantic direction, preprocessing fairness, or label leakage;
those remain review requirements.

Comparison-integrity requirements that code cannot fully enforce:

1. Do not read labels, rationales, tags, or existing benchmark results while
   creating vectors.
2. Do not train or tune the model on these 200 pairs. The runner may select a
   threshold afterward because that is the explicitly chosen no-CV methodology.
3. Embed only the supplied text. Do not add host, URL, page body, or method-only
   metadata unless the benchmark dataset and all compared methods are changed
   together.
4. Keep preprocessing deterministic and document model files, tokenizer,
   pooling, normalization, hardware/runtime, and any text prefix.

## Add A Method Without Editing The Runner

Create a normal importable module. For example:

```python
# experiments/my_embedding.py
from apps.server.app.config import AppConfig

from .provider import MyEmbeddingProvider


def create_benchmark_provider(config: AppConfig) -> MyEmbeddingProvider:
    return MyEmbeddingProvider(
        model_path="data/models/my-model/model.onnx",
        dimensions=256,
    )
```

Then pass a stable result name and the factory import path:

```bash
python scripts/benchmark_tier0_embeddings.py \
  --method hash \
  --method onnx \
  --method my_model=experiments.my_embedding:create_benchmark_provider \
  --output-dir data/embedding-benchmark-my-model
```

`--method` is repeatable. Method names must use lowercase letters, digits,
underscores, or hyphens. Output columns and plots are generated dynamically for
all selected methods. JSON and Markdown results also record each built-in name
or external `module:factory` source.

Built-in methods can be listed with:

```bash
python scripts/benchmark_tier0_embeddings.py --list-methods
```

If a method becomes a permanent repository baseline, add its factory to
`BUILTIN_METHODS` in `scripts/benchmark_tier0_embeddings.py`; it can then be run
as `--method name` without an import target.

## Evaluation Policy

- Positive class: `OK`, meaning an obvious-OK title Tier 0 may absorb.
- Score: cosine between the anchor embedding and title embedding.
- Threshold rule: predict OK when `score >= tau`.
- Cross-validation: none, by explicit project decision.
- Operating points: maximize recall subject to empirical FPR <=5%, 10%, 15%,
  20%, 30%, 40%, and 50%; ties prefer lower actual FPR, then higher threshold.
- Shared outputs: overall ROC AUC, partial AUC through FPR 30%, average
  precision, operating points, tag slices, all pair scores, and ROC SVG.

Use the fixed dataset for method comparison. A dataset change is a separate
benchmark-version change and should regenerate every baseline in the same run.
