# TypeScript providers

These providers are part of the authoritative serverless MV3 runtime. There is
no Python decision or delivery path.

## Tier 0

`tier0Wasm.ts` packages KoEn-E5 Tiny's O4 ONNX export and runs it through
`onnxruntime-web/wasm`, CPU-only and offline:

- pure-JS `@huggingface/tokenizers` with the pinned tokenizer;
- whitespace normalization and the `query: ` prefix;
- 128-token limit;
- attention-mask mean pooling;
- finite, non-zero, 384-dimensional, L2-normalized output.

The old Python qint8 export is not reused because its integer kernels produced
a different score space under ONNX Runtime Web. The packaged O4 export matches
Python `CPUExecutionProvider` over that same export within the committed parity
tolerance (`2e-4` for checked vector components and cosine).

The build fetches and hash-verifies the release asset, then copies the model,
tokenizer, and pinned `onnxruntime-web` WASM binary into `dist/assets/`. MV3 CSP
permits the packaged WASM binary; inference does not load a remote model.

## Ollama Tier 1 and Tier 2

`ollamaChat.ts` implements the optional `/api/chat` boundary:

- strict prompts and parsers;
- Context Judge / Message Writer separation;
- prompt-injection trust boundary;
- timeout and output-budget handling;
- API-key fallback and per-call rotation;
- safe structured errors without raw provider bodies or credentials.

Ollama is off until the user supplies a key in the options UI. `tier12.ts`
wires Tier 1 rescue and the Tier-2 Context Judge/Writer into the gauge pipeline.
Tier-2 requests are revalidated against their durable page, request, and goal
tokens before a result can act.

Payload builders in `payloads.ts` minimize the provider boundary. Requests may
contain the goal, current title/host, a bounded current-page excerpt, recent
titles/verdicts, and compact time/nag context. They do not send raw URLs,
stored vectors, the full event log, or unbounded history.

Cloud keys remain in extension-local storage and must never be committed.

## Failure behavior

Tier 0 remains available when Ollama is disabled or unhealthy. Provider health
is exposed in the UI, and failed optional calls degrade conservatively without
blocking browsing. A transient outbox failure remains durable for retry; a
stale page or goal result is cancelled.
