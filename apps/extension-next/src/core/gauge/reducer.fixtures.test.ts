// Replays every shared fixture (fixtures/gauge/*.json) through reduceGauge and
// asserts `expected` per fixtures/gauge/README.md. The Python track loads the
// same files. Run: `npm run test` (node --experimental-strip-types --test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { reduceGauge } from "./reducer.ts";
import { initGaugeState } from "./types.ts";
import type { GaugeConfig, GaugeEffect, GaugeEvent, GaugeState } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "../../../../../fixtures/gauge");

interface Assertion {
  field: string;
  op: "==" | "near" | ">=" | "<=" | ">" | "<";
  value: number;
}

interface Fixture {
  name: string;
  kind: "golden" | "property";
  config: GaugeConfig;
  initial_state: Partial<GaugeState>;
  events: GaugeEvent[];
  tolerance?: number;
  expected: {
    final_state?: Record<string, unknown>;
    assert?: Assertion[];
    effects_contain?: Partial<GaugeEffect>[];
  };
}

function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")) as Fixture);
}

function approxEq(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}

function checkOp(actual: number, op: Assertion["op"], value: number, tol: number): boolean {
  switch (op) {
    case "==":
    case "near":
      return approxEq(actual, value, tol);
    case ">=":
      return actual >= value;
    case "<=":
      return actual <= value;
    case ">":
      return actual > value;
    case "<":
      return actual < value;
  }
}

function field(obj: object, key: string): unknown {
  return (obj as unknown as Record<string, unknown>)[key];
}

function effectMatches(actual: GaugeEffect, expected: Partial<GaugeEffect>): boolean {
  return Object.entries(expected).every(([k, v]) => field(actual, k) === v);
}

function replay(fx: Fixture): { state: GaugeState; effects: GaugeEffect[] } {
  let state: GaugeState = { ...initGaugeState(), ...fx.initial_state };
  const effects: GaugeEffect[] = [];
  for (const ev of fx.events) {
    const t = reduceGauge(state, ev, fx.config);
    state = t.state;
    effects.push(...t.effects);
  }
  return { state, effects };
}

for (const fx of loadFixtures()) {
  test(`gauge fixture: ${fx.name}`, () => {
    const tol = fx.tolerance ?? 1e-6;
    const { state, effects } = replay(fx);

    for (const [k, v] of Object.entries(fx.expected.final_state ?? {})) {
      const actual = field(state, k);
      if (typeof v === "number" && typeof actual === "number") {
        assert.ok(approxEq(actual, v, tol), `${fx.name}: state.${k} = ${actual}, expected ≈ ${v}`);
      } else {
        assert.deepEqual(actual, v, `${fx.name}: state.${k}`);
      }
    }

    for (const a of fx.expected.assert ?? []) {
      const actual = field(state, a.field) as number;
      assert.ok(checkOp(actual, a.op, a.value, tol), `${fx.name}: ${a.field}=${actual} not ${a.op} ${a.value}`);
    }

    for (const exp of fx.expected.effects_contain ?? []) {
      assert.ok(
        effects.some((e) => effectMatches(e, exp)),
        `${fx.name}: effects missing ${JSON.stringify(exp)} (got ${JSON.stringify(effects)})`,
      );
    }
  });
}
