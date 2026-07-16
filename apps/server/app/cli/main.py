from __future__ import annotations

import argparse
import json

from ..ports import main as serve
from ..runtime_paths import RuntimePathsError, resolve_runtime_paths
from ..version import APP_VERSION


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    try:
        paths = resolve_runtime_paths()
    except RuntimePathsError as exc:
        parser.error(
            f"{exc}. Run Kibitzer from an editable repository checkout "
            "or use the packaged distribution."
        )

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
    subcommands.add_parser(
        "paths",
        help="print runtime roots and conventional default locations as JSON",
    )
    return parser


if __name__ == "__main__":
    raise SystemExit(main())
