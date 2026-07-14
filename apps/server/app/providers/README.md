# Providers

Providers hide model and API details from the core pipeline.

Stage 0 providers:

- `embeddings.onnx_cpu` - default local KoEn E5 Tiny qint8 ONNX embedding
- `embeddings.hash_cpu` - deterministic hashed-bigram baseline retained for
  tests and benchmarks
- `judges.ollama_chat` - Tier 1 and Tier 2 via Ollama-style `/api/chat`
  (Ollama Cloud default)
- `judges.openai_compatible` - OpenAI-compatible chat completions

Do not let provider-specific model names leak into core logic.
