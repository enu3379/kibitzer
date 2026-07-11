#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import csv
import importlib
import json
import math
import re
import sys
import time
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from html import escape
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from apps.server.app.config import AppConfig, load_config
from apps.server.app.core.relevance import cosine
from apps.server.app.providers.embeddings.base import EmbeddingProvider
from apps.server.app.providers.embeddings.factory import create_embedding_provider
from apps.server.app.providers.embeddings.hash_cpu import HashCpuEmbeddingProvider

DEFAULT_DATASET = ROOT / "scripts" / "fixtures" / "tier0_embedding_benchmark_dataset.json"
LEGACY_FIXTURE = ROOT / "scripts" / "fixtures" / "onnx_embedding_smoke_cases.json"
DEFAULT_OUTPUT_DIR = ROOT / "data" / "embedding-benchmark"
FPR_BUDGETS = (0.05, 0.10, 0.15, 0.20, 0.30)
DEFAULT_METHODS = ("hash", "onnx")
METHOD_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
STABILITY_COSINE_MIN = 0.999
CONTROLLED_TAGS = {
    "short_anchor",
    "short_title",
    "ko_semantic_no_overlap",
    "en_translation",
    "cross_lingual",
    "lexical_overlap_trap",
    "different_sense",
    "adjacent_topic",
    "easy_negative",
    "legacy_fixture",
}


@dataclass(frozen=True)
class ScoredPair:
    id: str
    group_id: str
    anchor: str
    title: str
    label: str
    tags: list[str]
    source: str
    rationale: str
    score: float


@dataclass(frozen=True)
class SweepPoint:
    threshold: float
    tp: int
    tn: int
    fp: int
    fn: int
    recall: float
    fpr: float
    precision: float
    specificity: float


@dataclass(frozen=True)
class MethodResult:
    name: str
    source: str
    dimensions: int
    cold_ms: float
    warm_ms: float
    roc_auc: float
    partial_roc_auc_0_30: float
    average_precision: float
    scored_pairs: list[ScoredPair]
    sweep: list[SweepPoint]
    operating_points: dict[str, SweepPoint]


ProviderFactory = Callable[[AppConfig], EmbeddingProvider]


@dataclass(frozen=True)
class BenchmarkMethod:
    name: str
    source: str
    provider: EmbeddingProvider


def create_hash_method(config: AppConfig) -> EmbeddingProvider:
    del config
    return HashCpuEmbeddingProvider(dimensions=256, normalize=True)


def create_onnx_method(config: AppConfig) -> EmbeddingProvider:
    if config.embedding.provider != "onnx_cpu":
        raise ValueError(
            "built-in method 'onnx' requires embedding.provider=onnx_cpu in --config"
        )
    return create_embedding_provider(config.embedding)


BUILTIN_METHODS: dict[str, ProviderFactory] = {
    "hash": create_hash_method,
    "onnx": create_onnx_method,
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compare Tier 0 embedding methods on one fixed dataset"
    )
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--config", type=Path, default=ROOT / "configs" / "default.yaml")
    parser.add_argument(
        "--method",
        action="append",
        dest="methods",
        metavar="NAME[=MODULE:FACTORY]",
        help=(
            "method to compare; repeat for multiple methods. Built-ins: hash, onnx. "
            "External factories receive AppConfig and return an EmbeddingProvider"
        ),
    )
    parser.add_argument(
        "--list-methods",
        action="store_true",
        help="print built-in method names and exit",
    )
    return parser.parse_args()


def parse_method_spec(spec: str) -> tuple[str, ProviderFactory | str]:
    name, separator, target = spec.partition("=")
    if not METHOD_NAME_RE.fullmatch(name):
        raise ValueError(
            f"invalid method name {name!r}; use lowercase letters, digits, '_' or '-'"
        )
    if not separator:
        factory = BUILTIN_METHODS.get(name)
        if factory is None:
            raise ValueError(
                f"unknown built-in method {name!r}; use NAME=MODULE:FACTORY for external methods"
            )
        return name, factory
    if not target or ":" not in target:
        raise ValueError(f"external method {name!r} must use NAME=MODULE:FACTORY")
    return name, target


def load_external_factory(target: str) -> ProviderFactory:
    module_name, attribute = target.rsplit(":", 1)
    if not module_name or not attribute:
        raise ValueError(f"invalid external factory target {target!r}")
    module = importlib.import_module(module_name)
    factory = getattr(module, attribute, None)
    if not callable(factory):
        raise ValueError(f"external factory {target!r} is not callable")
    return factory


def resolve_methods(specs: list[str], config: AppConfig) -> list[BenchmarkMethod]:
    methods: list[BenchmarkMethod] = []
    seen: set[str] = set()
    for spec in specs:
        name, factory_or_target = parse_method_spec(spec)
        if name in seen:
            raise ValueError(f"duplicate method name {name!r}")
        seen.add(name)
        factory = (
            factory_or_target
            if callable(factory_or_target)
            else load_external_factory(factory_or_target)
        )
        source = f"builtin:{name}" if callable(factory_or_target) else factory_or_target
        provider = factory(config)
        embed = getattr(provider, "embed", None)
        if not callable(embed):
            raise ValueError(f"method {name!r} factory returned an object without embed()")
        methods.append(BenchmarkMethod(name=name, source=source, provider=provider))
    return methods


def load_and_validate_dataset(dataset_path: Path) -> list[dict[str, Any]]:
    payload = json.loads(dataset_path.read_text(encoding="utf-8"))
    if payload.get("version") != 1 or not isinstance(payload.get("pairs"), list):
        raise ValueError("dataset must contain version=1 and a pairs list")
    pairs: list[dict[str, Any]] = payload["pairs"]
    errors: list[str] = []

    if len(pairs) != 200:
        errors.append(f"expected 200 pairs, got {len(pairs)}")
    ids = [item.get("id") for item in pairs]
    if len(set(ids)) != len(ids):
        errors.append("pair ids must be unique")
    anchor_titles = [(item.get("anchor"), item.get("title")) for item in pairs]
    if len(set(anchor_titles)) != len(anchor_titles):
        errors.append("anchor-title pairs must be unique")

    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in pairs:
        required = {"id", "group_id", "anchor", "title", "label", "tags", "source", "rationale"}
        missing = required - item.keys()
        if missing:
            errors.append(f"{item.get('id', '<missing id>')}: missing fields {sorted(missing)}")
            continue
        groups[item["group_id"]].append(item)
        if item["label"] not in {"OK", "DRIFT"}:
            errors.append(f"{item['id']}: invalid label {item['label']!r}")
        if item["source"] not in {"generated", "legacy_fixture"}:
            errors.append(f"{item['id']}: invalid source {item['source']!r}")
        if not isinstance(item["tags"], list) or not item["tags"]:
            errors.append(f"{item['id']}: tags must be a non-empty list")
        else:
            unknown = set(item["tags"]) - CONTROLLED_TAGS
            if unknown:
                errors.append(f"{item['id']}: unknown tags {sorted(unknown)}")
        is_short_anchor = len(str(item["anchor"]).split()) <= 3
        if ("short_anchor" in item["tags"]) != is_short_anchor:
            errors.append(f"{item['id']}: short_anchor tag does not match anchor length")
        is_short_title = len(str(item["title"]).split()) <= 6
        if ("short_title" in item["tags"]) != is_short_title:
            errors.append(f"{item['id']}: short_title tag does not match title length")
        if "en_translation" in item["tags"]:
            has_ascii_letter = any("A" <= char <= "Z" or "a" <= char <= "z" for char in item["title"])
            if item["label"] != "OK" or not has_ascii_letter:
                errors.append(f"{item['id']}: en_translation must be an English-containing OK row")
        if item["source"] == "legacy_fixture" and "legacy_fixture" not in item["tags"]:
            errors.append(f"{item['id']}: legacy source must carry legacy_fixture tag")

    if len(groups) != 40:
        errors.append(f"expected 40 groups, got {len(groups)}")
    for group_id, rows in groups.items():
        anchors = {row.get("anchor") for row in rows}
        labels = Counter(row.get("label") for row in rows)
        if len(rows) != 5 or len(anchors) != 1:
            errors.append(f"{group_id}: expected five rows with one anchor")
        if labels != Counter({"DRIFT": 3, "OK": 2}):
            errors.append(f"{group_id}: expected 2 OK and 3 DRIFT, got {dict(labels)}")

    label_counts = Counter(item.get("label") for item in pairs)
    if label_counts != Counter({"DRIFT": 120, "OK": 80}):
        errors.append(f"expected 80 OK and 120 DRIFT, got {dict(label_counts)}")

    anchors = {rows[0]["anchor"] for rows in groups.values() if rows}
    short_anchor_count = sum(len(anchor.split()) <= 3 for anchor in anchors)
    if short_anchor_count < 24:
        errors.append(f"expected at least 24 short anchors, got {short_anchor_count}")
    short_title_count = sum(len(item.get("title", "").split()) <= 6 for item in pairs)
    if short_title_count < 120:
        errors.append(f"expected at least 120 short titles, got {short_title_count}")
    short_pair_count = sum(
        len(item.get("anchor", "").split()) <= 3 and len(item.get("title", "").split()) <= 6
        for item in pairs
    )
    if short_pair_count < 80:
        errors.append(f"expected at least 80 short anchor-title pairs, got {short_pair_count}")
    for required_anchor in {"뉴스", "컴퓨터 쇼핑", "등기부등본", "코스피"}:
        if required_anchor not in anchors:
            errors.append(f"missing required anchor {required_anchor!r}")

    english_ok_groups = {
        item["group_id"]
        for item in pairs
        if item.get("label") == "OK" and "en_translation" in item.get("tags", [])
    }
    if len(english_ok_groups) < 30:
        errors.append(f"expected at least 30 groups with English OK titles, got {len(english_ok_groups)}")

    legacy = json.loads(LEGACY_FIXTURE.read_text(encoding="utf-8"))
    dataset_lookup = {(item.get("anchor"), item.get("title"), item.get("label")): item for item in pairs}
    for case in legacy:
        for candidate in case["candidates"]:
            label = "OK" if candidate["expected"] == "related" else "DRIFT"
            key = (case["anchor"], candidate["text"], label)
            item = dataset_lookup.get(key)
            if not item:
                errors.append(f"missing legacy pair: {key}")
            elif item.get("source") != "legacy_fixture" or "legacy_fixture" not in item.get("tags", []):
                errors.append(f"legacy pair lacks source/tag: {item.get('id')}")

    if errors:
        raise ValueError("dataset validation failed:\n- " + "\n- ".join(errors))
    return pairs


def build_sweep(scored_pairs: list[ScoredPair]) -> list[SweepPoint]:
    positives = sum(item.label == "OK" for item in scored_pairs)
    negatives = len(scored_pairs) - positives
    thresholds = [math.nextafter(max(item.score for item in scored_pairs), math.inf)]
    thresholds.extend(sorted({item.score for item in scored_pairs}, reverse=True))
    points: list[SweepPoint] = []
    for threshold in thresholds:
        tp = sum(item.label == "OK" and item.score >= threshold for item in scored_pairs)
        fp = sum(item.label == "DRIFT" and item.score >= threshold for item in scored_pairs)
        fn = positives - tp
        tn = negatives - fp
        recall = tp / positives if positives else 0.0
        fpr = fp / negatives if negatives else 0.0
        precision = tp / (tp + fp) if tp + fp else 1.0
        specificity = tn / negatives if negatives else 0.0
        points.append(
            SweepPoint(
                threshold=threshold,
                tp=tp,
                tn=tn,
                fp=fp,
                fn=fn,
                recall=recall,
                fpr=fpr,
                precision=precision,
                specificity=specificity,
            )
        )
    return points


def select_operating_point(points: list[SweepPoint], fpr_budget: float) -> SweepPoint:
    eligible = [point for point in points if point.fpr <= fpr_budget + 1e-12]
    if not eligible:
        raise ValueError(f"no threshold satisfies FPR <= {fpr_budget}")
    return max(eligible, key=lambda point: (point.recall, -point.fpr, point.threshold))


def trapezoid_auc(points: list[SweepPoint], max_fpr: float = 1.0) -> float:
    coordinates = sorted({(point.fpr, point.recall) for point in points})
    if coordinates[-1][0] < max_fpr:
        coordinates.append((max_fpr, coordinates[-1][1]))
    clipped: list[tuple[float, float]] = []
    for index, (fpr, recall) in enumerate(coordinates):
        if fpr <= max_fpr:
            clipped.append((fpr, recall))
            continue
        previous_fpr, previous_recall = coordinates[index - 1]
        span = fpr - previous_fpr
        ratio = (max_fpr - previous_fpr) / span if span else 0.0
        interpolated = previous_recall + ratio * (recall - previous_recall)
        clipped.append((max_fpr, interpolated))
        break
    area = sum(
        (right_x - left_x) * (left_y + right_y) / 2
        for (left_x, left_y), (right_x, right_y) in zip(clipped, clipped[1:], strict=False)
    )
    return area / max_fpr if max_fpr else 0.0


def average_precision(points: list[SweepPoint]) -> float:
    ordered = sorted(points, key=lambda point: point.recall)
    area = 0.0
    previous_recall = 0.0
    best_precision_to_right = [0.0] * len(ordered)
    running_best = 0.0
    for index in range(len(ordered) - 1, -1, -1):
        running_best = max(running_best, ordered[index].precision)
        best_precision_to_right[index] = running_best
    for index, point in enumerate(ordered):
        if point.recall > previous_recall:
            area += (point.recall - previous_recall) * best_precision_to_right[index]
            previous_recall = point.recall
    return area


async def score_method(
    name: str,
    source: str,
    provider: EmbeddingProvider,
    pairs: list[dict[str, Any]],
) -> MethodResult:
    texts = list(dict.fromkeys([text for item in pairs for text in (item["anchor"], item["title"])]))
    cold_started = time.perf_counter()
    cold_vectors = await provider.embed(texts)
    cold_ms = (time.perf_counter() - cold_started) * 1000
    dimensions = validate_embedding_batch(name, texts, cold_vectors)
    warm_started = time.perf_counter()
    warm_vectors = await provider.embed(texts)
    warm_ms = (time.perf_counter() - warm_started) * 1000
    validate_embedding_batch(name, texts, warm_vectors, expected_dimensions=dimensions)
    for index, (cold, warm) in enumerate(zip(cold_vectors, warm_vectors, strict=True)):
        stability = cosine(cold, warm)
        if stability < STABILITY_COSINE_MIN:
            raise ValueError(
                f"method {name!r} is not stable for input {index}: "
                f"cold/warm cosine {stability:.6f} < {STABILITY_COSINE_MIN}"
            )
    vector_by_text = dict(zip(texts, warm_vectors, strict=True))
    scored_pairs = [
        ScoredPair(
            id=item["id"],
            group_id=item["group_id"],
            anchor=item["anchor"],
            title=item["title"],
            label=item["label"],
            tags=item["tags"],
            source=item["source"],
            rationale=item["rationale"],
            score=cosine(vector_by_text[item["anchor"]], vector_by_text[item["title"]]),
        )
        for item in pairs
    ]
    sweep = build_sweep(scored_pairs)
    operating_points = {
        budget_key(budget): select_operating_point(sweep, budget) for budget in FPR_BUDGETS
    }
    return MethodResult(
        name=name,
        source=source,
        dimensions=dimensions,
        cold_ms=cold_ms,
        warm_ms=warm_ms,
        roc_auc=trapezoid_auc(sweep),
        partial_roc_auc_0_30=trapezoid_auc(sweep, max_fpr=0.30),
        average_precision=average_precision(sweep),
        scored_pairs=scored_pairs,
        sweep=sweep,
        operating_points=operating_points,
    )


def validate_embedding_batch(
    name: str,
    texts: list[str],
    vectors: list[list[float]],
    *,
    expected_dimensions: int | None = None,
) -> int:
    if not isinstance(vectors, list):
        raise ValueError(f"method {name!r} embed() must return list[list[float]]")
    if len(vectors) != len(texts):
        raise ValueError(
            f"method {name!r} returned {len(vectors)} vectors for {len(texts)} inputs"
        )
    dimensions = expected_dimensions
    for index, vector in enumerate(vectors):
        if not isinstance(vector, list) or not vector:
            raise ValueError(f"method {name!r} vector {index} must be a non-empty list")
        if dimensions is None:
            dimensions = len(vector)
        if len(vector) != dimensions:
            raise ValueError(
                f"method {name!r} vector {index} has dimension {len(vector)}; "
                f"expected {dimensions}"
            )
        if not all(isinstance(value, (int, float)) and math.isfinite(value) for value in vector):
            raise ValueError(f"method {name!r} vector {index} contains a non-finite number")
        if not any(value != 0.0 for value in vector):
            raise ValueError(f"method {name!r} vector {index} is zero")
    if dimensions is None:
        raise ValueError(f"method {name!r} received no benchmark inputs")
    return dimensions


def budget_key(budget: float) -> str:
    return str(int(round(budget * 100)))


def prediction(score: float, point: SweepPoint) -> str:
    return "OK" if score >= point.threshold else "DRIFT"


def build_tag_summary(
    pairs: list[dict[str, Any]],
    score_lookup: dict[tuple[str, str], float],
    method_names: list[str],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for tag in sorted({tag for item in pairs for tag in item["tags"]}):
        tagged = [item for item in pairs if tag in item["tags"]]
        ok_rows = [item for item in tagged if item["label"] == "OK"]
        drift_rows = [item for item in tagged if item["label"] == "DRIFT"]
        row: dict[str, Any] = {
            "tag": tag,
            "count": len(tagged),
            "ok_count": len(ok_rows),
            "drift_count": len(drift_rows),
        }
        for method in method_names:
            ok_scores = [score_lookup[(method, item["id"])] for item in ok_rows]
            drift_scores = [score_lookup[(method, item["id"])] for item in drift_rows]
            row[f"{method}_ok_mean"] = sum(ok_scores) / len(ok_scores) if ok_scores else None
            row[f"{method}_drift_mean"] = (
                sum(drift_scores) / len(drift_scores) if drift_scores else None
            )
        rows.append(row)
    return rows


def build_dataset_stats(pairs: list[dict[str, Any]]) -> dict[str, int]:
    anchors = {item["anchor"] for item in pairs}
    return {
        "pairs": len(pairs),
        "groups": len({item["group_id"] for item in pairs}),
        "short_anchors": sum(len(anchor.split()) <= 3 for anchor in anchors),
        "short_titles": sum(len(item["title"].split()) <= 6 for item in pairs),
        "short_anchor_title_pairs": sum(
            len(item["anchor"].split()) <= 3 and len(item["title"].split()) <= 6
            for item in pairs
        ),
        "english_ok_groups": len(
            {
                item["group_id"]
                for item in pairs
                if item["label"] == "OK" and "en_translation" in item["tags"]
            }
        ),
        "legacy_pairs": sum(item["source"] == "legacy_fixture" for item in pairs),
    }


def write_outputs(
    output_dir: Path,
    dataset_path: Path,
    pairs: list[dict[str, Any]],
    results: list[MethodResult],
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    by_method = {result.name: result for result in results}
    method_names = [result.name for result in results]
    score_lookup = {
        (result.name, item.id): item.score for result in results for item in result.scored_pairs
    }
    tag_summary = build_tag_summary(pairs, score_lookup, method_names)
    dataset_stats = build_dataset_stats(pairs)

    pair_csv = output_dir / "pair_scores.csv"
    fieldnames = [
        "id",
        "group_id",
        "anchor",
        "title",
        "label",
        "tags",
        "source",
        "rationale",
    ]
    fieldnames.extend(f"{method}_score" for method in method_names)
    for method in method_names:
        fieldnames.extend(f"{method}_at_fpr_{budget_key(budget)}" for budget in FPR_BUDGETS)
    with pair_csv.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for item in pairs:
            row: dict[str, Any] = {
                **item,
                "tags": ",".join(item["tags"]),
            }
            for method in method_names:
                row[f"{method}_score"] = f"{score_lookup[(method, item['id'])]:.8f}"
                for budget in FPR_BUDGETS:
                    point = by_method[method].operating_points[budget_key(budget)]
                    row[f"{method}_at_fpr_{budget_key(budget)}"] = prediction(
                        score_lookup[(method, item["id"])],
                        point,
                    )
            writer.writerow(row)

    tag_csv = output_dir / "tag_summary.csv"
    with tag_csv.open("w", encoding="utf-8-sig", newline="") as handle:
        tag_fieldnames = ["tag", "count", "ok_count", "drift_count"]
        for method in method_names:
            tag_fieldnames.extend((f"{method}_ok_mean", f"{method}_drift_mean"))
        writer = csv.DictWriter(handle, fieldnames=tag_fieldnames)
        writer.writeheader()
        writer.writerows(tag_summary)

    operating_csv = output_dir / "operating_points.csv"
    with operating_csv.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "method",
                "fpr_budget",
                "threshold",
                "tp",
                "tn",
                "fp",
                "fn",
                "recall",
                "fpr",
                "precision",
                "specificity",
            ],
        )
        writer.writeheader()
        for result in results:
            for budget in FPR_BUDGETS:
                point = result.operating_points[budget_key(budget)]
                writer.writerow(
                    {
                        "method": result.name,
                        "fpr_budget": budget,
                        **asdict(point),
                    }
                )

    try:
        dataset_label = str(dataset_path.resolve().relative_to(ROOT))
    except ValueError:
        dataset_label = str(dataset_path)

    report_payload = {
        "methodology": {
            "cross_validation": False,
            "positive_label": "OK",
            "prediction_rule": "score >= threshold",
            "selection": "maximize recall subject to empirical FPR budget; tie-break lower FPR then higher threshold",
            "fpr_budgets": list(FPR_BUDGETS),
            "embedding_contract": {
                "one_vector_per_input": True,
                "finite_non_zero": True,
                "fixed_dimensions_per_method": True,
                "cold_warm_cosine_min": STABILITY_COSINE_MIN,
            },
        },
        "dataset": dataset_label.replace("\\", "/"),
        "pair_count": len(pairs),
        "label_counts": dict(Counter(item["label"] for item in pairs)),
        "dataset_stats": dataset_stats,
        "tag_summary": tag_summary,
        "methods": [
            {
                "name": result.name,
                "source": result.source,
                "dimensions": result.dimensions,
                "cold_ms": result.cold_ms,
                "warm_ms": result.warm_ms,
                "roc_auc": result.roc_auc,
                "partial_roc_auc_0_30": result.partial_roc_auc_0_30,
                "average_precision": result.average_precision,
                "operating_points": {
                    key: {
                        **asdict(point),
                        "fp_ids": [
                            item.id
                            for item in result.scored_pairs
                            if item.label == "DRIFT" and item.score >= point.threshold
                        ],
                        "fn_ids": [
                            item.id
                            for item in result.scored_pairs
                            if item.label == "OK" and item.score < point.threshold
                        ],
                    }
                    for key, point in result.operating_points.items()
                },
                "sweep": [asdict(point) for point in result.sweep],
            }
            for result in results
        ],
        "pairs": [
            {
                **item,
                **{
                    f"{method}_score": score_lookup[(method, item["id"])]
                    for method in method_names
                },
            }
            for item in pairs
        ],
    }
    (output_dir / "benchmark_results.json").write_text(
        json.dumps(report_payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (output_dir / "report.md").write_text(
        build_markdown_report(pairs, results, score_lookup, tag_summary, dataset_stats),
        encoding="utf-8",
    )
    (output_dir / "roc.svg").write_text(build_roc_svg(results), encoding="utf-8")


def build_markdown_report(
    pairs: list[dict[str, Any]],
    results: list[MethodResult],
    score_lookup: dict[tuple[str, str], float],
    tag_summary: list[dict[str, Any]],
    dataset_stats: dict[str, int],
) -> str:
    by_method = {result.name: result for result in results}
    method_names = [result.name for result in results]
    lines = [
        "# Tier 0 Embedding Benchmark",
        "",
        "No cross-validation is used. Each method selects its threshold on all 200 pairs.",
        "Positive means `obvious OK`; higher scores predict OK.",
        "",
        "## Dataset",
        "",
        f"- Pairs: {dataset_stats['pairs']} across {dataset_stats['groups']} anchors",
        f"- Short anchors (<=3 words): {dataset_stats['short_anchors']}",
        f"- Short titles (<=6 words): {dataset_stats['short_titles']}",
        f"- Short anchor-title pairs: {dataset_stats['short_anchor_title_pairs']}",
        f"- Anchor groups with English OK title: {dataset_stats['english_ok_groups']}",
        f"- Legacy fixture pairs: {dataset_stats['legacy_pairs']}",
        "",
        "## Overall",
        "",
        "| Method | Source | Dimensions | Cold ms | Warm ms | ROC AUC | partial AUC FPR<=30% | Average precision |",
        "|---|---|---:|---:|---:|---:|---:|---:|",
    ]
    for result in results:
        lines.append(
            f"| {result.name} | {result.source} | {result.dimensions} | {result.cold_ms:.1f} | "
            f"{result.warm_ms:.1f} | {result.roc_auc:.4f} | "
            f"{result.partial_roc_auc_0_30:.4f} | {result.average_precision:.4f} |"
        )

    lines.extend(
        [
            "",
            "## Operating Points",
            "",
            "| FPR budget | Method | Tau | Recall | Actual FPR | FP | Precision |",
            "|---:|---|---:|---:|---:|---:|---:|",
        ]
    )
    for budget in FPR_BUDGETS:
        key = budget_key(budget)
        for method in method_names:
            point = by_method[method].operating_points[key]
            lines.append(
                f"| {budget:.0%} | {method} | {point.threshold:.6f} | "
                f"{point.recall:.1%} | {point.fpr:.1%} | {point.fp} | "
                f"{point.precision:.1%} |"
            )

    lines.extend(
        [
            "",
            "## Tag Slices",
            "",
            "| Tag | Method | Count | OK | DRIFT | OK mean | DRIFT mean |",
            "|---|---|---:|---:|---:|---:|---:|",
        ]
    )
    for row in tag_summary:
        for method in method_names:
            ok_mean = row[f"{method}_ok_mean"]
            drift_mean = row[f"{method}_drift_mean"]
            lines.append(
                f"| {row['tag']} | {method} | {row['count']} | {row['ok_count']} | "
                f"{row['drift_count']} | "
                f"{f'{ok_mean:.4f}' if ok_mean is not None else '-'} | "
                f"{f'{drift_mean:.4f}' if drift_mean is not None else '-'} |"
            )

    lines.extend(
        [
            "",
            "## All Pair Scores",
            "",
            f"| ID | Anchor | Title | Label | Tags | {' | '.join(method_names)} |",
            f"|---|---|---|---|---|{'|'.join('---:' for _ in method_names)}|",
        ]
    )
    for item in pairs:
        markdown_values = [
            str(item["id"]),
            str(item["anchor"]),
            str(item["title"]),
            str(item["label"]),
            ", ".join(item["tags"]),
        ]
        markdown_values = [value.replace("|", "\\|").replace("\n", " ") for value in markdown_values]
        scores = " | ".join(
            f"{score_lookup[(method, item['id'])]:.6f}" for method in method_names
        )
        lines.append(
            f"| {' | '.join(markdown_values)} | {scores} |"
        )
    lines.append("")
    return "\n".join(lines)


def build_roc_svg(results: list[MethodResult]) -> str:
    width, height = 820, 620
    left, top, plot_width, plot_height = 90, 50, 660, 500

    def point(fpr: float, recall: float) -> tuple[float, float]:
        return left + fpr * plot_width, top + (1.0 - recall) * plot_height

    elements = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" fill="white"/>',
        '<text x="410" y="28" text-anchor="middle" font-family="sans-serif" font-size="20">Tier 0 ROC: obvious OK</text>',
    ]
    for tick in range(0, 11):
        value = tick / 10
        x, y_bottom = point(value, 0)
        x_left, y = point(0, value)
        elements.append(f'<line x1="{x:.1f}" y1="{top}" x2="{x:.1f}" y2="{top + plot_height}" stroke="#e5e7eb"/>')
        elements.append(f'<line x1="{left}" y1="{y:.1f}" x2="{left + plot_width}" y2="{y:.1f}" stroke="#e5e7eb"/>')
        elements.append(f'<text x="{x:.1f}" y="{y_bottom + 24:.1f}" text-anchor="middle" font-family="sans-serif" font-size="11">{value:.1f}</text>')
        elements.append(f'<text x="{x_left - 14:.1f}" y="{y + 4:.1f}" text-anchor="end" font-family="sans-serif" font-size="11">{value:.1f}</text>')
    for budget in FPR_BUDGETS:
        x, _ = point(budget, 0)
        elements.append(
            f'<line x1="{x:.1f}" y1="{top}" x2="{x:.1f}" y2="{top + plot_height}" '
            'stroke="#94a3b8" stroke-dasharray="2 4"/>'
        )
    elements.extend(
        [
            f'<line x1="{left}" y1="{top + plot_height}" x2="{left + plot_width}" y2="{top}" stroke="#9ca3af" stroke-dasharray="5 5"/>',
            f'<line x1="{left}" y1="{top + plot_height}" x2="{left + plot_width}" y2="{top + plot_height}" stroke="#111827"/>',
            f'<line x1="{left}" y1="{top}" x2="{left}" y2="{top + plot_height}" stroke="#111827"/>',
            f'<text x="{left + plot_width / 2}" y="605" text-anchor="middle" font-family="sans-serif" font-size="14">False Positive Rate</text>',
            f'<text x="22" y="{top + plot_height / 2}" text-anchor="middle" transform="rotate(-90 22 {top + plot_height / 2})" font-family="sans-serif" font-size="14">Obvious OK Recall</text>',
        ]
    )
    colors = ("#d97706", "#059669", "#2563eb", "#dc2626", "#7c3aed", "#0891b2")
    for legend_index, result in enumerate(results):
        coordinates = sorted({(item.fpr, item.recall) for item in result.sweep})
        polyline = " ".join(f"{point(fpr, recall)[0]:.1f},{point(fpr, recall)[1]:.1f}" for fpr, recall in coordinates)
        color = colors[legend_index % len(colors)]
        elements.append(f'<polyline points="{polyline}" fill="none" stroke="{color}" stroke-width="3"/>')
        for operating_point in result.operating_points.values():
            marker_x, marker_y = point(operating_point.fpr, operating_point.recall)
            elements.append(
                f'<circle cx="{marker_x:.1f}" cy="{marker_y:.1f}" r="4" '
                f'fill="white" stroke="{color}" stroke-width="2"/>'
            )
        legend_y = 75 + legend_index * 26
        elements.append(f'<line x1="570" y1="{legend_y}" x2="610" y2="{legend_y}" stroke="{color}" stroke-width="3"/>')
        elements.append(
            f'<text x="620" y="{legend_y + 5}" font-family="sans-serif" font-size="13">'
            f'{escape(result.name)} AUC={result.roc_auc:.3f}</text>'
        )
    elements.append("</svg>")
    return "\n".join(elements)


async def main() -> int:
    args = parse_args()
    if args.list_methods:
        print("Built-in methods:")
        for name in BUILTIN_METHODS:
            print(f"  {name}")
        print("External method syntax: NAME=MODULE:FACTORY")
        return 0

    pairs = load_and_validate_dataset(args.dataset)
    config = load_config(args.config)
    method_specs = args.methods or list(DEFAULT_METHODS)
    methods = resolve_methods(method_specs, config)

    print(f"validated dataset: {len(pairs)} pairs")
    results: list[MethodResult] = []
    for method in methods:
        result = await score_method(method.name, method.source, method.provider, pairs)
        results.append(result)
        print(f"{method.name} scored: ROC AUC={result.roc_auc:.4f}")
    write_outputs(args.output_dir, args.dataset, pairs, results)

    print("\nFPR budget operating points")
    print("budget  method               recall       tau    actual FPR")
    for budget in FPR_BUDGETS:
        key = budget_key(budget)
        for result in results:
            point = result.operating_points[key]
            print(
                f"{budget:>5.0%}   {result.name:<20} {point.recall:>6.1%}   "
                f"{point.threshold: .6f}   {point.fpr:>6.1%}"
            )
    print(f"\noutputs: {args.output_dir}")
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(asyncio.run(main()))
