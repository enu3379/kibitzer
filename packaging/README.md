# Server package

Build the current platform's unsigned PyInstaller onedir distribution from the
repository root:

```bash
python -m pip install -e ".[package]"
python -m PyInstaller --clean --noconfirm packaging/kibitzer.spec
python scripts/smoke_packaged_server.py --dist-dir dist/kibitzer
```

The output is `dist/kibitzer/`, with dependencies/resources under `_internal/`.
macOS currently has the `kibitzer` server executable. Windows has the windowed
user-facing `Kibitzer.exe` tray app plus an internal `kibitzer-server.exe` for
the child server process and diagnostics. Distribute the whole directory, not
only an executable.

`kibitzer paths` reports runtime roots and conventional default locations. A
custom `KIBITZER_CONFIG` may override the effective database, embedding, or
provider-config paths; inspect that YAML when an override is active.

The package smoke uses the deterministic `hash_cpu` provider. It verifies the
frozen runtime and bundled Python dependencies, but does not prove that a
separately provisioned ONNX model/tokenizer can load; model provisioning needs
its own release-stage smoke before end-user distribution.

This is still an unsigned development distribution, not an end-user release.
Windows tray/server ownership is included; macOS app-bundle integration,
first-run model provisioning, an installer, and update channels remain.
