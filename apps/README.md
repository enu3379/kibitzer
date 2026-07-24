# Apps

Kibitzer is a single serverless Chrome MV3 extension. There is one app surface:

- `extension-next/` — the whole product: goal declaration, on-device relevance
  judging, the immersion gauge, optional Ollama Cloud judges, IndexedDB state,
  and non-blocking in-page toast delivery, all inside the extension. No server.

See [extension-next/README.md](extension-next/README.md) for build, run, and
architecture details. The pre-migration Python server + relay extension are
preserved on the `dev-legacy` branch.
