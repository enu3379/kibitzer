# Server package

Build the current platform's unsigned PyInstaller onedir distribution from the
repository root:

```bash
python -m pip install -e ".[package]"
python -m PyInstaller --clean --noconfirm packaging/kibitzer.spec
python scripts/smoke_packaged_server.py --dist-dir dist/kibitzer
```

The output is `dist/kibitzer/`, with `kibitzer` (`kibitzer.exe` on Windows) at
its root and dependencies/resources under `_internal/`. Distribute the whole
directory, not only the executable.

This is the server packaging core, not an end-user release. It is unsigned and
does not yet include platform tray/menu-bar ownership, first-run model
provisioning, an installer, or update channels.
