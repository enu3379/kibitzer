from __future__ import annotations

from multiprocessing import freeze_support

from apps.server.app.cli.main import main


if __name__ == "__main__":
    freeze_support()
    raise SystemExit(main())
