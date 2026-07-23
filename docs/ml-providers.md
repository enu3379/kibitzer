# ML Providers

## TypeScript migration shadow (Phase 4)

The extension now contains the future serverless provider boundary under
`apps/extension/src/providers/`. This is deliberately a shadow until Phase 5:
the Python server remains authoritative and all gauge effects remain
non-deliverable.

- Tier 0 packages KoEn E5 Tiny `model_O4.onnx` (74.9 MB), its original
  tokenizer files, and the pinned ONNX Runtime WASM binary. It runs CPU-only,
  offline, with the same prefix, token limit, mean pooling, dimensionality, and
  normalization contract as Python.
- The O4 export was selected because the previous qint8 export's integer
  kernels did not preserve its Python score space in ONNX Runtime Web. For O4,
  the committed Python-CPU/WASM parity test checks vector components and cosine
  within `2e-4`.
- Tier 0 runs after the shipping server verdict and stores only its last
  diagnostic result. The popup developer view shows the goal-title score and
  both verdicts, labeled `발송 안 함`.
- The Ollama `/api/chat` Tier 1/2 client, canonical trust-boundary prompts,
  strict response parsers, minimized payload builders, timeout/output-budget
  logic, and key rotation are ported. Network calls are disabled by default;
  see
  [`apps/extension/src/providers/README.md`](../apps/extension/src/providers/README.md)
  for explicit local configuration.

The shadow Tier 0 score is goal-versus-title only. The current server Tier 0
also considers exemplars, derived phrases, and the anchor, so a displayed
verdict difference is a migration diagnostic rather than a parity failure.
The old qint8 `tau_ok=0.6` must be recalibrated for O4 under D4 before cutover.

## Provider Policy

Embedding is local CPU-only in Stage 0. CUDA, Metal, DirectML, and GPU-specific
dependencies are not part of the default path. The setup scripts download the
model and tokenizer once; ordinary Tier 0 inference makes no network call.

Tier 1 and Tier 2 both support OpenAI-compatible chat completions, Ollama `/api/chat`
providers, and the `experiment` models-file indirection. A tier that is enabled but
cannot resolve credentials degrades to the lower tier's verdict and records a
`provider.degraded` event when the runtime first activates. A per-call Tier 1 failure keeps the Tier 0
verdict and records `tier1.provider_error`; it never fails the observation request.

## Stage 0 Defaults

```yaml
embedding:
  provider: onnx_cpu
  model: ./data/models/koen-e5-tiny-onnx/onnx/model_qint8_arm64.onnx
  tokenizer_path: ./data/models/koen-e5-tiny-onnx/tokenizer.json
  device: cpu
  forbid_gpu: true
  batch_size: 1
  dimensions: 384

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

Configured tiers separately expose the last real provider call under
`/health.provider_calls`. The result starts as `none`, changes to `error` with a
coarse failure reason when a call fails, and returns to `success` after the next
successful call for that tier. While a tier's last call is an error, the popup
shows one diagnostic card per failed tier in Tier 1 → Tier 2 order. The card
identifies the Judge/Writer phase, response stage, severity, and applicable
fallback without making another provider request. Health polling never probes
the provider or creates extra API usage.

Each call status also includes `phase` (`judge` or `writer`) and a response
`stage`. The stage is one of `http_json`, `envelope`, `content_json`, `schema`,
`writer_empty`, or `output_exhausted`; it is `null` for request failures that
occur before response decoding. These fields are diagnostic metadata only. Raw
provider responses are never exposed or persisted. See
[`handoff-provider-response-failures.md`](handoff-provider-response-failures.md)
for the decision tree and examples.

Failure reasons deliberately stay coarse and never expose raw provider errors,
URLs, or API keys to the extension:

| Reason | Detected from | Popup summary |
|---|---|---|
| `timeout` | provider request timeout | `Provider 응답 시간이 초과됐어요.` |
| `connection` | DNS, connection refused, or another network error | `Provider 서버에 연결하지 못했어요.` |
| `auth` | HTTP 401 | `API 키가 유효하지 않아요.` |
| `forbidden` | HTTP 403 | `Provider가 요청을 거부했어요. 모델 접근 권한 또는 요금제를 확인하세요.` |
| `rate_limited` | HTTP 429 | `Provider 요청 한도에 도달했어요.` |
| `server_error` | HTTP 5xx | `Provider 서버에서 오류가 발생했어요.` |
| `invalid_response` | invalid JSON or judge response shape | `Provider 응답을 판정 결과로 읽지 못했어요.` |
| `other` | any unclassified failure | `Provider 상태를 확인하세요.` |

For `invalid_response`, the popup uses `stage` to distinguish transport JSON,
response envelope, content JSON, schema, empty Writer output, and exhausted
output limits. A missing stage retains the legacy invalid-response summary; a
missing phase uses the generic LLM-call title and red severity. Unknown runtime
values safely fall back to `Provider 상태를 확인하세요.` Offline snapshots do
not synthesize provider failures. See
[`handoff-popup-provider-failure-details.md`](handoff-popup-provider-failure-details.md)
for the complete copy, severity, fallback, and privacy rules.

## Tier 0

Tier 0 embeds the declared goal/exemplars and normalized page title, then uses
cosine similarity. URL hosts and page bodies are excluded. The default
`onnx_cpu` provider uses KoEn E5 Tiny qint8 with the original tokenizer,
attention-mask mean pooling, and L2 normalization:

```text
r0 = max(max cosine to goal exemplars, beta * cosine to anchor)
```

If `r0 >= tau_ok`, the observation is OK.

The old `hash_cpu` provider remains as a deterministic comparison baseline.
Implementation and setup details are in
[`apps/server/app/providers/embeddings/README.md`](../apps/server/app/providers/embeddings/README.md),
and the fixed 200-pair evaluation is in
[`docs/benchmarks/tier0-embedding/report.md`](benchmarks/tier0-embedding/report.md).

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
