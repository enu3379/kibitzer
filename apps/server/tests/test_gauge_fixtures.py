"""Shared gauge fixture runner (B track).

Auto-discovers every ``fixtures/gauge/*.json`` (repo-root relative) and replays it through
:func:`reduce_gauge`, asserting ``expected`` per the runner semantics in
``fixtures/gauge/README.md``:

- ``final_state`` (golden): every listed field of the final state matches exactly (floats
  within ``tolerance``).
- ``assert`` (property): each entry checks one final-state field with an operator
  (``== >= <= < > near``); ``==``/``near`` on a float use ``tolerance``.
- ``effects_contain``: the **union** of all effects emitted across every event must contain
  each listed effect (subset match on the listed keys; extra effect fields ignored).

Both language tracks load the *same* JSON files; do not edit fixtures to make a test pass.
"""

import json
import math
from pathlib import Path

import pytest

from apps.server.app.core.controllers.gauge import (
    GaugeConfig,
    GaugeEvent,
    GaugeState,
    reduce_gauge,
)

_REPO_ROOT = Path(__file__).resolve().parents[3]
_FIXTURE_DIR = _REPO_ROOT / "fixtures" / "gauge"


def _fixture_files() -> list[Path]:
    return sorted(_FIXTURE_DIR.glob("*.json"))


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _replay(fixture: dict) -> tuple[GaugeState, list[dict]]:
    config = GaugeConfig.from_json(fixture["config"])
    state = GaugeState.from_json(fixture.get("initial_state", {}))
    union_effects: list[dict] = []
    for raw_event in fixture["events"]:
        transition = reduce_gauge(state, GaugeEvent.from_json(raw_event), config)
        state = transition.state
        union_effects.extend(effect.to_json() for effect in transition.effects)
    return state, union_effects


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _floats_equal(a: float, b: float, tol: float) -> bool:
    return math.isclose(a, b, rel_tol=0.0, abs_tol=tol)


def _compare_op(actual, op: str, expected, tol: float) -> bool:
    if op in ("==", "near"):
        if _is_number(actual) and _is_number(expected):
            return _floats_equal(float(actual), float(expected), tol)
        return actual == expected
    if op == ">=":
        return actual >= expected
    if op == "<=":
        return actual <= expected
    if op == ">":
        return actual > expected
    if op == "<":
        return actual < expected
    raise AssertionError(f"unknown assert op: {op!r}")


def _effect_matches(emitted: dict, wanted: dict, tol: float) -> bool:
    for key, want_value in wanted.items():
        if key not in emitted:
            return False
        actual = emitted[key]
        if _is_number(actual) and _is_number(want_value):
            if not _floats_equal(float(actual), float(want_value), tol):
                return False
        elif actual != want_value:
            return False
    return True


@pytest.mark.parametrize("fixture_path", _fixture_files(), ids=lambda p: p.stem)
def test_gauge_fixture(fixture_path: Path) -> None:
    fixture = _load(fixture_path)
    tol = float(fixture.get("tolerance", 1e-6))
    final_state, union_effects = _replay(fixture)
    final_json = final_state.to_json()
    expected = fixture.get("expected", {})

    # golden: exact final_state fields
    for field_name, want_value in expected.get("final_state", {}).items():
        actual = final_json[field_name]
        if _is_number(actual) and _is_number(want_value):
            assert _floats_equal(float(actual), float(want_value), tol), (
                f"{fixture_path.name}: final_state.{field_name} = {actual!r}, "
                f"expected {want_value!r} (tol {tol})"
            )
        else:
            assert actual == want_value, (
                f"{fixture_path.name}: final_state.{field_name} = {actual!r}, expected {want_value!r}"
            )

    # property: per-field operator assertions
    for check in expected.get("assert", []):
        field_name = check["field"]
        op = check["op"]
        want_value = check["value"]
        actual = final_json[field_name]
        assert _compare_op(actual, op, want_value, tol), (
            f"{fixture_path.name}: assert {field_name} {op} {want_value!r} failed (actual {actual!r})"
        )

    # effects_contain: union of emitted effects must contain each listed effect (subset match)
    for wanted in expected.get("effects_contain", []):
        assert any(_effect_matches(emitted, wanted, tol) for emitted in union_effects), (
            f"{fixture_path.name}: no emitted effect matched {wanted!r}; got {union_effects!r}"
        )


def test_fixture_directory_is_discovered() -> None:
    # Guard against a silently-empty glob (which would make the parametrized test vacuous).
    assert _fixture_files(), f"no gauge fixtures found under {_FIXTURE_DIR}"
