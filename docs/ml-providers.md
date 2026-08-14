# ML providers

## Tier 0: local embedding

Tier 0 runs entirely in the extension with KoEn-E5 Tiny O4 ONNX through
`onnxruntime-web` WASM. The model and tokenizer metadata are pinned under
`apps/extension/assets/models/koen-e5-tiny/`; `npm run build` downloads
the uncommitted model binary and verifies its size and SHA-256.

The browser tokenizer and WASM vectors are regression-tested against the
Python reference evidence. The shipped operating point is `tauOk=0.59`.
Trajectory anchoring is disabled by default (`ANCHOR_WINDOW=0`).

## Tier 1 and Tier 2: opt-in Ollama Cloud

The options page stores an API-key pool, API URL, and model names in Chrome
local storage. With no keys, Kibitzer remains in local Tier-0 mode.

Defaults:

```text
API URL  https://ollama.com/api/chat
Tier 1   nemotron-3-super
Tier 2   minimax-m3
```

Tier 1 can rescue a Tier-0 DRIFT after seeing the goal, current title/host, and
recent title/verdict context. Tier 2 reviews a potential intervention with the
same context plus Tier-0 diagnostics, a bounded current-page excerpt, and
compact time information. A separate persona writer creates the Korean nudge
after a `notify` decision.

The exact privacy boundary is in `docs/privacy.md` and is disclosed beside the
API-key field.

## Reliability behavior

- Keys rotate on authentication, authorization, and rate-limit responses.
- Tier 1 failure keeps DRIFT and records a coarse provider-health error.
- Tier 2 judge failure fails open without a nudge.
- Tier 2 writer failure uses the selected persona's local fallback template.
- Raw provider responses, keys, and request bodies are not persisted in the
  activity log.

## Implementation

- `apps/extension/src/providers/ollamaChat.ts` — HTTP client and key
  rotation.
- `apps/extension/src/providers/payloads.ts` — minimized request shapes.
- `apps/extension/src/providers/prompts.ts` — classifier and trust-boundary
  prompts.
- `apps/extension/src/providers/judgeParsing.ts` — strict response parsing.
- `apps/extension/src/providers/tier0Wasm.ts` — tokenizer/ONNX inference.
- `apps/extension/src/lib/tier12.ts` — live Tier-1/Tier-2 wiring.

Run `npm run build` from `apps/extension` for provider tests, WASM parity,
type checks, and bundling.
