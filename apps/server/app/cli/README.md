# CLI

The installed entry point starts and diagnoses the local server:

```bash
kibitzer
kibitzer serve
kibitzer paths
kibitzer --version
```

Session replay remains available as `python -m apps.server.app.replay` until it
is deliberately folded into the installed command tree. Calibration is still
planned rather than exposed as a stub command.
