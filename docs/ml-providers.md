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
  experiment_models_file: configs/models.local.yaml
  experiment_model_key: tier1_fast   # Ollama Cloud nemotron-3-super — 2-3s hot-path classifier
  timeout_seconds: 10            # hot path: caps the models-file timeout

tier2:
  provider: experiment
  experiment_models_file: configs/models.local.yaml
  experiment_model_key: tier2_judge   # Ollama Cloud minimax-m3 judge + Korean copywriter
  model: minimax-m3
```

## Where model settings and keys live

Two gitignored files, set up once:

- `configs/models.local.yaml` — endpoints and model names per tier. Template:
  `configs/experiment-models.example.yaml` (Ollama Cloud by default; swap
  `ollama_model` for anything in https://ollama.com/library).
- `.env` — API keys only (`ollama1=` / `ollama2=`). Template: `.env.example`.
  `load_dotenv` runs at config load, so every start mode — terminal, macOS
  LaunchAgent, Windows tray — picks keys up with no per-run setup.

Key resolution order per tier: environment variable named by `api_key_env`
(from `.env` or the shell) → `api_key:` field in the models file → for
`localhost`/`127.0.0.1` URLs a placeholder is injected (self-hosted Ollama
ignores auth, so purely local setups need no key at all).

If a tier cannot resolve, it degrades to the tier below, `/health` reports
`tiers: {tierN: degraded}`, and the extension popup shows a
"판정 축소 모드" warning — degradation is loud, not silent.

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

The default config reads the Ollama Cloud API URL and model name from
`configs/models.local.yaml` and the API keys from `.env` (see "Where model
settings and keys live" above). Kibitzer never commits keys to this repository.

Useful checks:

```bash
.venv/bin/python scripts/smoke_tier2_provider_config.py
.venv/bin/python scripts/smoke_tier2_provider_config.py --call
```
