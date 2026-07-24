# TypeScript providers

Phase 4 moves the provider boundary into the MV3 extension without changing
which runtime is authoritative. The Python server still owns decisions and
delivery until Phase 5.

## Tier 0

`tier0Wasm.ts` packages KoEn E5 Tiny's O4 ONNX export and runs it with
`onnxruntime-web/wasm`, CPU-only and fully offline:

- pure-JS `@huggingface/tokenizers` over the pinned `tokenizer.json`;
- whitespace normalization and the `query: ` prefix;
- one input at a time, with a 128-token limit;
- attention-mask mean pooling;
- finite, non-zero, 384-dimensional, L2-normalized output.

The previous Python qint8 export is not reused. Its integer kernels produced a
different score space under ONNX Runtime Web. The O4 export is 74.9 MB and
matches Python `CPUExecutionProvider` over the same export within the committed
parity tolerance (`2e-4` per checked vector component and cosine).

The build copies the model, tokenizer files, and the exact
`onnxruntime-web@1.27.0` WASM binary into `dist/assets/`. MV3 CSP permits only
the packaged WebAssembly binary; no CDN or remote model load is used.

## Ollama Tier 1/2

`ollamaChat.ts` ports the existing `/api/chat` client, including:

- strict JSON prompts and parsers;
- Context Judge / Message Writer separation;
- prompt-injection trust boundary;
- timeout and output-budget handling;
- API-key fallback and per-call rotation;
- safe structured errors without raw provider bodies or credentials.

Payload builders in `payloads.ts` preserve the minimized Python wire shapes.
Tier 1 and Tier 2 are disabled by default in the shadow runner so Phase 4 does
not create surprise model usage. A developer can opt Tier 1 into diagnostics
from the extension service-worker console:

```js
await chrome.storage.local.set({
  "kibitzer:ts-provider-config:v1": {
    version: 1,
    tier0: { enabled: true, tauOk: 0.6 },
    tier1: {
      enabled: true,
      apiUrl: "http://127.0.0.1:11434/api/chat",
      model: "qwen3.5:9b",
      timeoutMs: 10000,
      maxOutputTokens: 128
    }
  }
})
```

Local Ollama needs no API key. Cloud keys, when used, belong only in extension
local storage and must never be committed. Tier 2 is bundled and tested but is
not invoked from the gauge outbox until Phase 5 defines request cancellation,
acknowledgement, and notification cutover as one lifecycle.

## Shadow boundary

`lib/providerShadow.ts` runs Tier 0 after the shipping server result and stores
only the last diagnostic result in `chrome.storage.session`. Its goal-title
score is not a full replacement for the server's goal/exemplar/derived/anchor
maximum. It never dispatches a provider verdict into the gauge or notification
path. The developer popup labels this explicitly as `발송 안 함`.
