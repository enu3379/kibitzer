# ML Providers

## Provider Policy

Embedding must be local CPU-only in Stage 0. CUDA, Metal, DirectML, and GPU-specific dependencies are not part of the default path.

Tier 1 and Tier 2 both support OpenAI-compatible chat completions, Ollama `/api/chat`
providers, and the `experiment` models-file indirection. A tier that is enabled but
cannot resolve credentials degrades to the lower tier's verdict and records a
`provider.degraded` event when the runtime first activates. A per-call Tier 1 failure keeps the Tier 0
verdict and records `tier1.provider_error`; it never fails the observation request.

## Stage 0 Defaults

```yaml
embedding:
  provider: hash_cpu
  model: token-hash-v2   # Hangul character bigrams + whole tokens, title-only input
  device: cpu
  forbid_gpu: true

tier1:
  provider: experiment
  experiment_models_file: %KIBITZER_EXPERIMENT_MODELS_FILE%
  experiment_model_key: gemma4   # local Ollama gemma4:e4b, zero API cost
  timeout_seconds: 10            # hot path: caps the models-file timeout

tier2:
  provider: experiment
  experiment_models_file: %KIBITZER_EXPERIMENT_MODELS_FILE%
  experiment_model_key: ollama_cloud_gemma4_31b
  model: gemma4:31b
```

## Tier 0

Tier 0 uses embeddings and cosine similarity:

```text
r0 = max(max cosine to goal exemplars, beta * cosine to anchor)
```

If `r0 >= tau_ok`, the observation is OK.

## Tier 1

Tier 1 classifies ambiguous observations. It receives:

- goal text
- recent title/verdict pairs
- current title
- current URL host

It does not receive:

- page body
- query string
- complete browsing history
- sensitive domains

Required output:

```json
{"verdict":"ok","reason":"normal subtopic"}
```

The OpenAI-compatible client calls `/chat/completions` and requests JSON object output. If Tier 1 is not configured in local development, Stage 0 keeps the Tier 0 verdict.

## Tier 2

Tier 2 runs only after the controller decides an intervention may be needed. It receives:

- goal text
- recent title/verdict pairs
- current title, URL host, Tier 0 score, and verdict
- current page excerpt with char limit

It returns:

```json
{
  "confirm_drift": true,
  "message": "..."
}
```

If Tier 2 cancels, no notification is shown.

The default local config reads the Ollama Cloud API URL, model name, primary API key, and fallback API key from the experiment project model file at runtime. Kibitzer does not copy those keys into this repository. Environment variables `TIER2_API_KEY` and `TIER2_FALLBACK_API_KEY` override the experiment file when present.

Useful checks:

```bash
.venv/bin/python scripts/smoke_tier2_provider_config.py
.venv/bin/python scripts/smoke_tier2_provider_config.py --call
```
