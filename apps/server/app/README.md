# Server App Package

This package contains the FastAPI app and the source-neutral core pipeline.

## Boundaries

- `api/` translates HTTP requests into application calls.
- `core/` owns source-neutral judgment and controller flow.
- `providers/` owns external/local ML calls.
- `privacy/` owns drop/redaction rules.
- `logging/` owns append-only event logs and replay inputs.
- `cli/` owns local commands such as replay.

