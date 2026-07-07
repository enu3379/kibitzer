# Providers

Providers hide model and API details from the core pipeline.

Stage 0 providers:

- `embeddings.onnx_cpu` - local CPU-only embedding
- `judges.openai_compatible` - Tier 1 and Tier 2 API calls

Do not let provider-specific model names leak into core logic.

