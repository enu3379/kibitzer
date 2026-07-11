#!/usr/bin/env python3
"""Create a guarded sibling worktree for a new dev-based task branch."""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path


ALLOWED_BRANCH_PREFIXES = ("feature/", "fix/", "chore/", "codex/")
SLOT_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]*$")


class WorktreeError(RuntimeError):
    """Raised when creating a worktree would violate the repository policy."""


def git(
    root: Path,
    *args: str,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["git", *args],
        cwd=root,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if check and result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise WorktreeError(f"git {' '.join(args)} failed: {detail}")
    return result


def require_canonical_dev(root: Path) -> None:
    detected_root = Path(
        git(root, "rev-parse", "--show-toplevel").stdout.strip()
    ).resolve()
    if detected_root != root.resolve():
        raise WorktreeError(f"script root {root} is not the Git root {detected_root}")

    branch = git(root, "branch", "--show-current").stdout.strip()
    if branch != "dev":
        raise WorktreeError(
            f"the canonical checkout must be on dev, but this checkout is on {branch or 'detached HEAD'}"
        )

    status = git(root, "status", "--porcelain").stdout.strip()
    if status:
        raise WorktreeError("the canonical dev checkout is not clean")

    upstream = git(root, "rev-parse", "--abbrev-ref", "@{upstream}", check=False)
    if upstream.returncode == 0:
        counts = git(root, "rev-list", "--left-right", "--count", "HEAD...@{upstream}")
        ahead, behind = (int(value) for value in counts.stdout.split())
        if ahead or behind:
            raise WorktreeError(
                f"dev is not synchronized with {upstream.stdout.strip()} "
                f"(ahead {ahead}, behind {behind}); update it before creating a worktree"
            )


def validate_new_branch(root: Path, branch: str) -> None:
    if not branch.startswith(ALLOWED_BRANCH_PREFIXES):
        allowed = ", ".join(ALLOWED_BRANCH_PREFIXES)
        raise WorktreeError(f"branch must start with one of: {allowed}")

    valid_ref = git(root, "check-ref-format", "--branch", branch, check=False)
    if valid_ref.returncode != 0:
        raise WorktreeError(f"invalid branch name: {branch}")

    for ref in (f"refs/heads/{branch}", f"refs/remotes/origin/{branch}"):
        exists = git(root, "show-ref", "--verify", "--quiet", ref, check=False)
        if exists.returncode == 0:
            raise WorktreeError(
                f"branch already exists at {ref}; attach it manually instead of creating a new branch"
            )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create <repo>-<slot> on a new dev-based task branch.",
    )
    parser.add_argument("slot", help="worktree suffix, for example A or B")
    parser.add_argument("branch", help="new feature/, fix/, chore/, or codex/ branch")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = Path(__file__).resolve().parents[1]

    if not SLOT_PATTERN.fullmatch(args.slot):
        raise WorktreeError("slot must contain only letters, numbers, and hyphens")

    slot = args.slot.upper()
    target = root.parent / f"{root.name}-{slot}"

    require_canonical_dev(root)
    validate_new_branch(root, args.branch)

    if target.exists():
        raise WorktreeError(f"target already exists: {target}")

    result = git(root, "worktree", "add", "-b", args.branch, str(target), "dev")
    if result.stdout.strip():
        print(result.stdout.strip())
    if result.stderr.strip():
        print(result.stderr.strip(), file=sys.stderr)

    print(f"Created {target}")
    print(f"Branch: {args.branch}")
    print(f"Next: initialize dependencies inside {target}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except WorktreeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
