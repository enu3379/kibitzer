from __future__ import annotations

import argparse
import asyncio
from pathlib import Path

from ..config import load_config
from .core import (
    apply_config_overrides,
    format_report,
    list_sessions,
    replay_session,
    write_csv,
    write_json,
)


def main(argv: list[str] | None = None) -> None:
    parser = _parser()
    args = parser.parse_args(argv)

    config = load_config(args.config)
    config, overrides = apply_config_overrides(config, args.override)
    db_path = Path(args.db or config.server.db_path)

    if args.live_tiers:
        raise SystemExit("--live-tiers is reserved for a follow-up; this replay uses recorded tier results.")

    if args.list_sessions:
        for session in list_sessions(db_path):
            ended = session.ended_at.isoformat() if session.ended_at else ("active" if session.active else "")
            goal = session.goal or ""
            print(f"{session.id}\t{session.created_at.isoformat()}\t{ended}\t{session.observation_count}\t{goal}")
        return

    if not args.session and not args.latest:
        parser.error("provide --session, --latest, or --list-sessions")

    result = asyncio.run(
        replay_session(
            db_path,
            session=args.session,
            latest=args.latest,
            config=config,
            overrides=overrides,
            derived_phrases_path=args.derived_phrases,
        )
    )
    print(format_report(result, full=args.full))

    if args.csv:
        write_csv(args.csv, result)
    if args.json:
        write_json(args.json, result)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m apps.server.app.replay",
        description=(
            "Replay one Kibitzer session from the SQLite log without writing to the source DB. "
            "Config is taken only from --config and --override; runtime settings stored in the DB "
            "are deliberately ignored so counterfactual configs are explicit."
        ),
    )
    parser.add_argument("--db", help="SQLite DB path (default: server.db_path from replay config)")
    parser.add_argument("--session", help="Session id or unique id prefix")
    parser.add_argument("--latest", action="store_true", help="Replay the newest ended session that has a goal")
    parser.add_argument("--list-sessions", action="store_true", help="List sessions and exit")
    parser.add_argument(
        "--config",
        help="Replay config path (default: the resolved Kibitzer config)",
    )
    parser.add_argument(
        "--override",
        action="append",
        default=[],
        help="Repeatable dotted-path config override, for example relevance.tau_ok=0.2",
    )
    parser.add_argument("--csv", help="Write labeling CSV")
    parser.add_argument("--json", help="Write machine-readable JSON")
    parser.add_argument(
        "--derived-phrases",
        help="Inject derived phrases JSON after goal.declared (format: goals.<session_id>.phrases)",
    )
    parser.add_argument("--full", action="store_true", help="Print every observation instead of only changed rows")
    parser.add_argument("--live-tiers", action="store_true", help="Reserved: re-call live tiers for missing recordings")
    return parser


if __name__ == "__main__":
    main()
