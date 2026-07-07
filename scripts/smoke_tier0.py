#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request
from pathlib import Path


BASE_URL = os.environ.get("KIBITZER_BASE_URL", "http://127.0.0.1:8765")
DB_PATH = Path(os.environ.get("KIBITZER_DB_PATH", "data/kibitzer.sqlite3"))


def post_json(path: str, payload: dict[str, object] | None = None) -> dict[str, object]:
    data = json.dumps(payload or {}).encode("utf-8")
    request = urllib.request.Request(
        f"{BASE_URL}{path}",
        data=data,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        raise SystemExit(f"request failed for {path}: {exc}") from exc


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    session = post_json("/sessions")
    session_id = str(session["id"])
    post_json(
        "/sessions/current/goal",
        {"raw_text": "Kibitzer observation API", "keywords": ["api"]},
    )

    ok = post_json(
        "/observations/browser-nav",
        {
            "source": "browser_nav",
            "payload": {
                "url": "https://example.com/kibitzer-api",
                "title": "Kibitzer observation API docs",
            },
        },
    )
    drift = post_json(
        "/observations/browser-nav",
        {
            "source": "browser_nav",
            "payload": {
                "url": "https://example.com/bread",
                "title": "Sourdough bread recipe",
            },
        },
    )

    assert_true(ok.get("verdict") == "OK", "related observation should be Tier 0 OK")
    assert_true(drift.get("verdict") == "DRIFT", "unrelated observation should be Tier 0 DRIFT")

    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            """
            SELECT verdict, features_json
            FROM observations
            WHERE session_id = ?
            ORDER BY ts ASC, id ASC
            """,
            (session_id,),
        ).fetchall()
        ok_count = conn.execute(
            "SELECT COUNT(*) FROM observations WHERE session_id = ? AND verdict = 'OK'",
            (session_id,),
        ).fetchone()[0]

    assert_true([row[0] for row in rows] == ["OK", "DRIFT"], "expected OK then DRIFT observations")
    features = [json.loads(row[1]) for row in rows]
    assert_true(features[0]["tier_reached"] == 0, "OK observation should be Tier 0")
    assert_true(features[0]["r0"] >= 0.55, "OK r0 should meet threshold")
    assert_true(features[1]["r0"] < 0.55, "DRIFT r0 should be below threshold")
    assert_true(ok_count == 1, "only OK observations should contribute to the anchor source set")

    print("PASS success scenario: related observation judged OK")
    print("PASS failure scenario: unrelated observation judged DRIFT")
    print("PASS anchor scenario: only OK observations are anchor candidates")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as exc:
        print(f"FAIL {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
