# Gauge shared fixtures

Language-neutral behavior fixtures for the gauge reducer. **Both** implementations load
these exact files and must pass all of them (see `docs/gauge/contract.md`):

- **A (TypeScript):** `apps/extension/src/core/gauge/reducer.fixtures.test.ts`
- **B (Python):** `apps/server/tests/test_gauge_fixtures.py`

A test runner replays each fixture: start from `initial_state` (fields not listed take the
init defaults in contract §2), apply `events` in order through `reduceGauge`, then check
`expected`.

## Fixture schema

```json
{
  "name": "kebab-id",
  "kind": "golden" | "property",
  "description": "human summary",
  "config": { /* full GaugeConfig; §8 placeholder knobs pinned here */ },
  "initial_state": { /* partial GaugeState */ },
  "events": [ { "type": "...", "ts": <ms>, ... } ],
  "tolerance": 1e-6,
  "expected": {
    "final_state": { /* golden: exact field values, float compared within tolerance */ },
    "assert": [ { "field": "s", "op": "==|>=|<=|<|>|near", "value": 0 } ],
    "effects_contain": [ { "type": "request_tier2", "reason": "s_zero" } ]
  }
}
```

## Runner semantics (both languages must match)

- **Time unit:** `ts` is epoch **milliseconds**; the reducer converts Δ to seconds (contract §5).
- **Floats:** compare within `tolerance` (default `1e-6`). `op:"near"` uses tolerance; `==` on a
  float also uses tolerance.
- **`final_state`** (golden): assert every listed field of the final state exactly.
- **`assert`** (property): each entry checks one final-state field with the given operator.
- **`effects_contain`:** the **union** of all effects emitted across every event must contain
  each listed effect (subset match on the listed keys; extra effect fields are ignored).
- Fields present in neither `final_state`/`assert` nor `effects_contain` are not asserted.

## Two kinds

- **golden** — short, hand-computable steps with exact `final_state`. These pin the formula
  and operation order. Recompute only when a §8 knob in that fixture's `config` changes.
- **property** — longer scenarios asserting qualitative invariants (S reaches 0, S nearly
  unchanged, an effect was emitted). Robust to knob tuning.

New real-data findings (from B) enter as a new failing fixture first, then both reducers are
fixed to pass it — this is the sync protocol in `docs/gauge-dual-track.md`.
