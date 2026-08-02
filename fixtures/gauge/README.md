# Gauge shared fixtures

Language-neutral behavior fixtures for the gauge reducer. The authoritative
TypeScript runtime loads every JSON file here from:

- `apps/extension-next/src/core/gauge/reducer.fixtures.test.ts`

Before the serverless cutover, a temporary Python reference reducer also loaded
these files to validate cross-language parity. That implementation was removed
with the server and remains available only through
`pre-serverless-cutover-2026-07-24`.

The test runner starts from `initial_state` (fields not listed take the init
defaults in [the gauge contract](../../docs/gauge/contract.md) §2), applies
`events` in order through `reduceGauge`, then checks `expected`.

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

## Runner semantics

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

When a finding changes the language-neutral gauge contract, add a failing
fixture first and then update the TypeScript reducer. Runtime-only events and
durability behavior that are outside the shared contract belong in focused
tests under `apps/extension-next/src/core/gauge/` or `src/lib/`.

Run the fixture suite from `apps/extension-next` with `npm test` (or as part of
`npm run build`).
