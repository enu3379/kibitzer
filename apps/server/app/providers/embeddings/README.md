# Embedding Providers

Stage 0 supports CPU-only embedding. The current default is `hash_cpu`, a deterministic local token-hash provider used for reproducible pipeline tests and smoke checks.

The replaceable implementation target remains ONNX Runtime CPU once model assets are wired in.

No CUDA, Metal, or DirectML dependency should be required by the default install path.
