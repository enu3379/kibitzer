# Providers

Providers hide model and API details from the core pipeline.

Stage 0 providers:

- `embeddings.hash_cpu` - local CPU-only hashed-bigram embedding (ONNX is a
  future upgrade)
- `judges.ollama_chat` - Tier 1 and Tier 2 via Ollama-style `/api/chat`
  (Ollama Cloud default)
- `judges.openai_compatible` - OpenAI-compatible chat completions

Do not let provider-specific model names leak into core logic.

