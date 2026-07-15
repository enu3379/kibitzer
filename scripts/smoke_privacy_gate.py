#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sqlite3
import sys
from pathlib import Path

from local_api import post_json

DB_PATH = Path(os.environ.get("KIBITZER_DB_PATH", "data/kibitzer.sqlite3"))


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    session = post_json("/sessions")
    session_id = str(session["id"])

    allowed = post_json(
        "/observations/browser-nav",
        {
            "source": "browser_nav",
            "payload": {
                "url": "https://example.com/research/path?debug=secret#fragment",
                "title": "Research Page",
                "tab_id": 101,
            },
        },
    )
    allowed_observation_id = allowed.get("observation_id")
    assert_true(isinstance(allowed_observation_id, str), "allowed navigation should create an observation")

    sensitive = post_json(
        "/observations/browser-nav",
        {
            "source": "browser_nav",
            "payload": {
                "url": "https://checkout.stripe.com/pay?client_secret=secret#card",
                "title": "Payment Secret",
                "tab_id": 102,
            },
        },
    )
    assert_true(sensitive.get("action") == "none", "sensitive navigation should be a no-op action")
    assert_true(sensitive.get("observation_id") is None, "sensitive navigation should not create an observation")

    with sqlite3.connect(DB_PATH) as conn:
        observation_count = conn.execute(
            "SELECT COUNT(*) FROM observations WHERE session_id = ? AND id = ?",
            (session_id, allowed_observation_id),
        ).fetchone()[0]
        dropped_payload = conn.execute(
            """
            SELECT payload_json
            FROM event_log
            WHERE session_id = ? AND event_type = 'observation.dropped'
            ORDER BY id DESC
            LIMIT 1
            """,
            (session_id,),
        ).fetchone()[0]

    assert_true(observation_count == 1, "allowed observation should be stored in SQLite")
    assert_true("checkout.stripe.com" in dropped_payload, "drop log should include the sensitive host")
    assert_true("client_secret" not in dropped_payload, "drop log must not include query secrets")
    assert_true("/pay" not in dropped_payload, "drop log must not include raw URL paths")
    assert_true("Payment Secret" not in dropped_payload, "drop log must not include sensitive page titles")

    print("PASS success scenario: allowed navigation stored")
    print("PASS failure scenario: sensitive navigation dropped with minimal log")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as exc:
        print(f"FAIL {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
