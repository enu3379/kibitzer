#!/usr/bin/env python3
"""Measure what goal-enrichment derived phrases add on top of the Tier 0 provider.

Scores every anchor-title pair of the Tier 0 benchmark dataset twice —
base = cosine(goal, title), enriched = the production scoring rule
max(base, derived-if-above-derived_tau) — using the embedding provider from
configs/default.yaml, and reports recall/FPR/AUC at tau_ok plus the pairs
each rule flips. Phrase sets live in a fixture so the experiment stays
reproducible; see docs/handoff-goal-enrichment.md addendum (2026-07-13) for
the recorded results and caveats.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from apps.server.app.config import load_config
from apps.server.app.core.relevance import cosine
from apps.server.app.providers.embeddings.factory import create_embedding_provider

DEFAULT_DATASET = ROOT / "scripts" / "fixtures" / "tier0_embedding_benchmark_dataset.json"
DEFAULT_PHRASES = ROOT / "scripts" / "fixtures" / "goal_enrichment_sim_phrases.json"
EMBED_BATCH = 32
REPORT_TAGS = ("cross_lingual", "ko_semantic_no_overlap", "lexical_overlap_trap")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--phrases", type=Path, default=DEFAULT_PHRASES)
    parser.add_argument("--tau-ok", type=float, default=None, help="defaults to relevance.tau_ok from config")
    parser.add_argument("--derived-tau", type=float, default=None, help="defaults to goal_enrichment.derived_tau from config")
    parser.add_argument("--json-output", type=Path, help="optionally write per-pair scores as JSON")
    return parser.parse_args()


def auc(ok_scores: list[float], drift_scores: list[float]) -> float:
    wins = ties = 0
    for ok in ok_scores:
        for drift in drift_scores:
            if ok > drift:
                wins += 1
            elif ok == drift:
                ties += 1
    return (wins + 0.5 * ties) / (len(ok_scores) * len(drift_scores))


async def main() -> int:
    args = parse_args()
    if not args.dataset.exists():
        print(f"dataset not found: {args.dataset} (lands with the Tier 0 benchmark, PR #29)", file=sys.stderr)
        return 1
    pairs = json.loads(args.dataset.read_text(encoding="utf-8"))["pairs"]
    phrase_sets: dict[str, list[str]] = json.loads(args.phrases.read_text(encoding="utf-8"))["phrases"]
    missing = {p["group_id"] for p in pairs} - set(phrase_sets)
    if missing:
        print(f"phrase fixture lacks groups: {sorted(missing)}", file=sys.stderr)
        return 1

    config = load_config()
    tau_ok = config.relevance.tau_ok if args.tau_ok is None else args.tau_ok
    derived_tau = config.goal_enrichment.derived_tau if args.derived_tau is None else args.derived_tau
    provider = create_embedding_provider(config.embedding)

    texts = list(dict.fromkeys(
        [p["anchor"] for p in pairs]
        + [p["title"] for p in pairs]
        + [phrase for phrases in phrase_sets.values() for phrase in phrases]
    ))
    vectors: dict[str, list[float]] = {}
    for start in range(0, len(texts), EMBED_BATCH):
        chunk = texts[start : start + EMBED_BATCH]
        for text, vector in zip(chunk, await provider.embed(chunk), strict=True):
            vectors[text] = vector

    rows = []
    for pair in pairs:
        base = cosine(vectors[pair["anchor"]], vectors[pair["title"]])
        derived = max(
            (cosine(vectors[phrase], vectors[pair["title"]]) for phrase in phrase_sets[pair["group_id"]]),
            default=0.0,
        )
        enriched = max(base, derived if derived >= derived_tau else 0.0)
        rows.append({**pair, "base": base, "derived": derived, "enriched": enriched})

    def report(label: str, subset) -> None:
        selected = [r for r in rows if subset(r)]
        ok = {k: [r[k] for r in selected if r["label"] == "OK"] for k in ("base", "enriched")}
        drift = {k: [r[k] for r in selected if r["label"] == "DRIFT"] for k in ("base", "enriched")}
        print(f"\n[{label}] OK={len(ok['base'])} DRIFT={len(drift['base'])}")
        for key in ("base", "enriched"):
            recall = sum(s >= tau_ok for s in ok[key]) / len(ok[key]) if ok[key] else float("nan")
            fpr = sum(s >= tau_ok for s in drift[key]) / len(drift[key]) if drift[key] else float("nan")
            line = f"  {key:9} | recall {recall:6.1%} | FPR {fpr:6.1%}"
            if ok[key] and drift[key]:
                line += f" | AUC {auc(ok[key], drift[key]):.4f}"
            print(line)

    print(f"tau_ok={tau_ok}  derived_tau={derived_tau}  pairs={len(rows)}  provider={config.embedding.provider}")
    report("all", lambda r: True)
    for tag in REPORT_TAGS:
        report(tag, lambda r, t=tag: t in r["tags"])

    rescued = [r for r in rows if r["label"] == "OK" and r["base"] < tau_ok <= r["enriched"]]
    false_ok = [r for r in rows if r["label"] == "DRIFT" and r["base"] < tau_ok <= r["enriched"]]
    print(f"\nOK rescued by enrichment: {len(rescued)}")
    print(f"DRIFT flipped to false-OK: {len(false_ok)}")
    for row in false_ok:
        print(f"  ! {row['group_id']:14} {row['base']:.3f}->{row['enriched']:.3f} | {row['anchor']} => {row['title']}")

    if args.json_output:
        args.json_output.parent.mkdir(parents=True, exist_ok=True)
        args.json_output.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\nJSON: {args.json_output}")
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(asyncio.run(main()))
