from __future__ import annotations

import argparse
import json

from ..ports import main as serve
from ..runtime_paths import resolve_runtime_paths
from ..version import APP_VERSION


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    paths = resolve_runtime_paths()

    if args.command == "paths":
        print(json.dumps(paths.diagnostics(), indent=2, sort_keys=True))
        return 0
    return serve(paths)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="kibitzer",
        description="Run and inspect the Kibitzer local server.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {APP_VERSION}")
    subcommands = parser.add_subparsers(dest="command")
    subcommands.add_parser("serve", help="start the local server (default)")
    subcommands.add_parser("paths", help="print resolved runtime paths as JSON")
    return parser


if __name__ == "__main__":
    raise SystemExit(main())
