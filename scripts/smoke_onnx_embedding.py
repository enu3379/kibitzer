#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import json
import math
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from apps.server.app.config import load_config
from apps.server.app.providers.embeddings.factory import create_embedding_provider


FIXTURE_PATH = ROOT / "scripts" / "fixtures" / "onnx_embedding_smoke_cases.json"


def cosine(left: list[float], right: list[float]) -> float:
    return sum(a * b for a, b in zip(left, right, strict=True))


async def timed_embed(provider: Any, texts: list[str]) -> tuple[list[list[float]], float]:
    started = time.perf_counter()
    vectors = await provider.embed(texts)
    return vectors, (time.perf_counter() - started) * 1000


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Detailed KoEn E5 Tiny ONNX similarity smoke test")
    parser.add_argument(
        "--json-output",
        type=Path,
        help="optionally write every measured score and latency as JSON",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="exit non-zero when any case has a related/unrelated ranking inversion",
    )
    return parser.parse_args()


async def main() -> int:
    args = parse_args()
    config = load_config()
    if config.embedding.provider != "onnx_cpu":
        raise RuntimeError("configs/default.yaml is not using the onnx_cpu provider")

    cases: list[dict[str, Any]] = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    texts = list(
        dict.fromkeys(
            text
            for case in cases
            for text in [case["anchor"], *(item["text"] for item in case["candidates"])]
        )
    )
    provider = create_embedding_provider(config.embedding)
    cold_vectors, cold_ms = await timed_embed(provider, texts)
    warm_vectors, warm_ms = await timed_embed(provider, texts)
    vectors = dict(zip(texts, warm_vectors, strict=True))

    print("KoEn E5 Tiny qint8 ONNX detailed similarity report")
    print(f"model:     {config.embedding.model}")
    print(f"tokenizer: {config.embedding.tokenizer_path}")
    print(f"texts:     {len(texts)}")
    print(f"vectors:   {len(warm_vectors)} x {len(warm_vectors[0])}")
    print(f"cold:      {cold_ms:.1f} ms total, {cold_ms / len(texts):.1f} ms/text")
    print(f"warm:      {warm_ms:.1f} ms total, {warm_ms / len(texts):.1f} ms/text")

    ranking_failures: list[str] = []
    related_scores: list[float] = []
    unrelated_scores: list[float] = []
    report_cases: list[dict[str, Any]] = []
    for index, case in enumerate(cases, start=1):
        anchor = case["anchor"]
        measurements: list[dict[str, Any]] = []
        print("\n" + "=" * 88)
        print(f"CASE {index:02d} | {case['name']}")
        print(f"ANCHOR       | {anchor}")
        print("-" * 88)

        for candidate in case["candidates"]:
            expected = candidate["expected"]
            score = cosine(vectors[anchor], vectors[candidate["text"]])
            measurements.append({**candidate, "cosine": score})
            if expected == "related":
                related_scores.append(score)
            else:
                unrelated_scores.append(score)
            verdict = "OK" if score >= config.relevance.tau_ok else "DRIFT"
            print(
                f"{expected.upper():12} | {score: .6f} | {verdict:5} @ tau | "
                f"{candidate['text']}"
            )

        case_related = [item["cosine"] for item in measurements if item["expected"] == "related"]
        case_unrelated = [item["cosine"] for item in measurements if item["expected"] == "unrelated"]
        margin = min(case_related) - max(case_unrelated)
        passed = margin > 0
        print("-" * 88)
        print(
            f"RANKING      | {'PASS' if passed else 'FAIL'} | "
            f"min related={min(case_related):.6f}, "
            f"max unrelated={max(case_unrelated):.6f}, margin={margin:+.6f}"
        )
        if not passed:
            ranking_failures.append(case["name"])
        report_cases.append(
            {
                "name": case["name"],
                "anchor": anchor,
                "measurements": measurements,
                "min_related": min(case_related),
                "max_unrelated": max(case_unrelated),
                "margin": margin,
                "passed": passed,
            }
        )

    norms = [math.sqrt(sum(value * value for value in vector)) for vector in warm_vectors]
    invalid_norms = [norm for norm in norms if not math.isclose(norm, 1.0, rel_tol=1e-6, abs_tol=1e-6)]
    accepted_related = sum(score >= config.relevance.tau_ok for score in related_scores)
    accepted_unrelated = sum(score >= config.relevance.tau_ok for score in unrelated_scores)

    print("\n" + "=" * 88)
    print("GLOBAL SUMMARY")
    print(f"related range:   {min(related_scores):.6f} .. {max(related_scores):.6f}")
    print(f"unrelated range: {min(unrelated_scores):.6f} .. {max(unrelated_scores):.6f}")
    print(f"configured tau:  {config.relevance.tau_ok:.6f}")
    print(f"case ranking:    {len(cases) - len(ranking_failures)}/{len(cases)} passed")
    print(
        f"tau decisions:   related OK {accepted_related}/{len(related_scores)}, "
        f"unrelated OK {accepted_unrelated}/{len(unrelated_scores)}"
    )

    report = {
        "model": config.embedding.model,
        "tokenizer": config.embedding.tokenizer_path,
        "dimensions": len(warm_vectors[0]),
        "text_count": len(texts),
        "cold_ms": cold_ms,
        "warm_ms": warm_ms,
        "configured_tau": config.relevance.tau_ok,
        "related_range": [min(related_scores), max(related_scores)],
        "unrelated_range": [min(unrelated_scores), max(unrelated_scores)],
        "accepted_related": accepted_related,
        "accepted_unrelated": accepted_unrelated,
        "cases": report_cases,
    }
    if args.json_output:
        args.json_output.parent.mkdir(parents=True, exist_ok=True)
        args.json_output.write_text(
            json.dumps(report, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"JSON report:     {args.json_output}")

    if invalid_norms:
        print(f"FAIL: non-normalized vectors: {invalid_norms}")
        return 1
    if ranking_failures:
        print("RANKING WARNINGS: " + ", ".join(ranking_failures))
        if args.strict:
            return 1
    print("PASS: runtime, dimensions, normalization, and detailed score report completed")
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(asyncio.run(main()))
