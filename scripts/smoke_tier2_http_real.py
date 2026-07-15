#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
from pathlib import Path

from local_api import post_json

DB_PATH = Path(os.environ.get("KIBITZER_DB_PATH", "data/kibitzer.sqlite3"))
MARKER = f"TIER2_HTTP_REAL_MARKER_{int(time.time())}"


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    session = post_json("/sessions")
    session_id = str(session["id"])
    post_json("/sessions/current/goal", {"raw_text": "Kibitzer Tier2 endpoint integration"})

    request_excerpt: dict[str, object] | None = None
    for index in range(1, 8):
        result = post_json(
            "/observations/browser-nav",
            {
                "source": "browser_nav",
                "payload": {
                    "url": f"https://example.com/cake-{index}?token=not-stored-{index}",
                    "title": f"Cake frosting tutorial {index}",
                },
            },
        )
        if result.get("action") == "request_excerpt":
            request_excerpt = result
            break

    assert_true(request_excerpt is not None, "drift streak should request excerpt")
    observation_id = str(request_excerpt["observation_id"])
    final = post_json(
        f"/observations/{observation_id}/excerpt",
        {
            "title": "Cake frosting tutorial",
            "text": f"{MARKER} This page is about buttercream, oven timing, and cake decoration.",
        },
        timeout=180,
    )

    assert_true(final.get("action") == "notify", f"expected notify from real Tier2 provider, got {final}")
    assert_true(bool(final.get("message")), "real Tier2 notify should include a message")
    assert_true(str(final.get("intervention_id", "")).startswith("int_"), "real Tier2 should create intervention")

    with sqlite3.connect(DB_PATH) as conn:
        event_payloads = "\n".join(
            row[0]
            for row in conn.execute(
                "SELECT payload_json FROM event_log WHERE session_id = ?",
                (session_id,),
            ).fetchall()
        )
    assert_true(MARKER not in event_payloads, "raw excerpt marker must not be persisted")

    print("PASS success scenario: real Tier2 HTTP flow returned notify")
    print("PASS privacy scenario: raw excerpt marker was not persisted")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as exc:
        print(f"FAIL {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
