"""Build/runtime metadata so a running process can report which code it runs.

APP_VERSION alone cannot distinguish two dev builds; the git commit (with a
dirty marker) and the process start time make a stale server or binary
diagnosable from /health without inspecting the machine.
"""

from __future__ import annotations

import subprocess
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

from .version import APP_VERSION

_REPO_ROOT = Path(__file__).resolve().parents[3]
_GIT_TIMEOUT_SECONDS = 2.0

SERVER_STARTED_AT = datetime.now(timezone.utc).isoformat(timespec="seconds")


def _run_git(*args: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(_REPO_ROOT), *args],
            capture_output=True,
            text=True,
            timeout=_GIT_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip()


@lru_cache(maxsize=1)
def git_commit() -> str | None:
    """Short commit hash of the source checkout, "+dirty" when it has
    uncommitted tracked changes. None when git or the checkout is unavailable
    (e.g. packaged builds)."""
    commit = _run_git("rev-parse", "--short", "HEAD")
    if not commit:
        return None
    if _run_git("status", "--porcelain", "--untracked-files=no"):
        commit += "+dirty"
    return commit


def build_info() -> dict[str, str | None]:
    return {
        "version": APP_VERSION,
        "git_commit": git_commit(),
        "started_at": SERVER_STARTED_AT,
    }
