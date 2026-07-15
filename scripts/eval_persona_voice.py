#!/usr/bin/env python3
"""Live persona voice audit through the real Tier 2 Message Writer.

v5 (judge/writer split): the Context Judge is not exercised here — every
scenario is a pre-judged notify case, so each call goes straight to the
plain-text Writer with the production payload shape (no page excerpt).
The request mirrors write_tier2_message() but keeps the raw HTTP response
so thinking/eval-count budget stats stay observable.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from apps.server.app.config import load_config
from apps.server.app.core.delivery import clamp_notification_message
from apps.server.app.core.personas import (
    compose_tier2_writer_system_prompt,
    format_persona_fallback,
    load_personas,
)
from apps.server.app.core.tier2_payload import build_tier2_message_payload
from apps.server.app.providers.judges.base import Tier2Decision
from apps.server.app.providers.judges.factory import create_tier2_judge_provider
from apps.server.app.providers.judges.ollama_chat import (
    _message_content,
    _writer_output_budget_exhausted,
)


SCENARIOS: list[dict[str, Any]] = [
    {
        "id": "S1",
        "label": "논문 조사 중 유튜브 침착맨 (첫 알림·명백한 이탈)",
        "goal": "졸업논문 선행연구 조사",
        "title": "침착맨 삼국지 3시간 풀버전",
        "host": "youtube.com",
        "prior_nag_count": 0,
        "last_nag_ignored": False,
        "drift_minutes": 6,
        "repeat_host": False,
    },
    {
        "id": "S2",
        "label": "이력서 중 쿠팡 (세 번째 알림·직전 무시·반복 방문)",
        "goal": "노션 이력서 완성",
        "title": "기계식 키보드 로켓배송 특가",
        "host": "coupang.com",
        "prior_nag_count": 2,
        "last_nag_ignored": True,
        "drift_minutes": 14,
        "repeat_host": True,
    },
    {
        "id": "S3",
        "label": "리팩토링 중 게임 패치노트 (그럴싸한 딴짓·반복)",
        "goal": "FastAPI 예외 핸들링 리팩토링",
        "title": "몬스터헌터 대검 밸런스 조정 패치노트",
        "host": "inven.co.kr",
        "prior_nag_count": 1,
        "last_nag_ignored": False,
        "drift_minutes": 9,
        "repeat_host": True,
    },
    {
        "id": "S4",
        "label": "발표자료 중 넷플릭스 (장시간 25분·직전 무시)",
        "goal": "Google Slides 발표자료 완성",
        "title": "흑백요리사 4화",
        "host": "netflix.com",
        "prior_nag_count": 1,
        "last_nag_ignored": True,
        "drift_minutes": 25,
        "repeat_host": True,
    },
    {
        "id": "S5",
        "label": "자격증 공부 중 더쿠 (첫 알림·일반 이탈)",
        "goal": "정보처리기사 실기 공부",
        "title": "요즘 유행하는 6500원 쿠키 가격 논란",
        "host": "theqoo.net",
        "prior_nag_count": 0,
        "last_nag_ignored": False,
        "drift_minutes": 4,
        "repeat_host": False,
    },
]

NOTIFY_DECISION = Tier2Decision(decision="notify", reason_code="off_goal", basis="title")


def build_writer_payload(scenario: dict[str, Any]) -> dict[str, object]:
    goal = SimpleNamespace(raw_text=scenario["goal"])
    observation = SimpleNamespace(title=scenario["title"], url_host=scenario["host"])
    nagging_context = {
        # Server semantics: nags already delivered today BEFORE this one.
        "nag_count_today": scenario["prior_nag_count"],
        "last_nag_ignored": scenario["last_nag_ignored"],
        "drift_minutes": scenario["drift_minutes"],
        "repeat_host": scenario["repeat_host"],
    }
    return build_tier2_message_payload(goal, observation, NOTIFY_DECISION, None, nagging_context)


def fallback_for(persona: Any, scenario: dict[str, Any]) -> str:
    goal = SimpleNamespace(raw_text=scenario["goal"])
    observation = SimpleNamespace(title=scenario["title"], url_host=scenario["host"])
    current_ordinal = int(scenario["prior_nag_count"]) + 1
    return format_persona_fallback(persona, goal, observation, current_ordinal) or ""


def response_stats(response: dict[str, object]) -> dict[str, object]:
    message = response.get("message")
    thinking = message.get("thinking") if isinstance(message, dict) else None
    return {
        "done_reason": response.get("done_reason"),
        "prompt_eval_count": response.get("prompt_eval_count"),
        "eval_count": response.get("eval_count"),
        "thinking_chars": len(thinking) if isinstance(thinking, str) else 0,
    }


async def evaluate_one(
    provider: Any,
    persona_key: str,
    persona: Any,
    scenario: dict[str, Any],
    semaphore: asyncio.Semaphore,
) -> dict[str, object]:
    payload = build_writer_payload(scenario)
    max_sentences = persona.max_sentences or 2
    queued_at = time.monotonic()
    queue_wait_seconds = 0.0
    request_latency_seconds = 0.0
    raw_content = ""
    response: dict[str, object] = {}
    writer_message: str | None = None
    writer_error: str | None = None
    fallback_used = False

    try:
        async with semaphore:
            request_started = time.monotonic()
            queue_wait_seconds = request_started - queued_at
            # Mirrors OllamaChatJudgeProvider.write_tier2_message() exactly,
            # but keeps the raw response for budget stats.
            try:
                response = await provider._post_chat(
                    [
                        {"role": "system", "content": compose_tier2_writer_system_prompt(persona)},
                        {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
                    ],
                    think=False,
                    num_predict=provider.writer_max_output_tokens,
                    json_mode=False,
                )
            finally:
                request_latency_seconds = time.monotonic() - request_started
        raw_content = _message_content(response)
        if _writer_output_budget_exhausted(response, provider.writer_max_output_tokens):
            raise ValueError("tier2 writer response exhausted output budget")
        content = raw_content.strip()
        if not content:
            raise ValueError("tier2 writer response was empty")
        writer_message = content[:320]
    except Exception as exc:  # Mirrors the server's writer-failure fallback.
        writer_error = f"{type(exc).__name__}: {exc}"
        fallback_used = True

    pre_clamp = writer_message if writer_message else fallback_for(persona, scenario)
    delivered = clamp_notification_message(pre_clamp, max_sentences) if pre_clamp else ""
    completion_seconds = round(time.monotonic() - queued_at, 3)

    return {
        "persona": persona_key,
        "persona_name": persona.name,
        "scenario": scenario["id"],
        "scenario_label": scenario["label"],
        "prior_nag_count": scenario["prior_nag_count"],
        "current_nag_ordinal": int(scenario["prior_nag_count"]) + 1,
        "queue_wait_seconds": round(queue_wait_seconds, 3),
        "request_latency_seconds": round(request_latency_seconds, 3),
        "completion_seconds": completion_seconds,
        "raw_content": raw_content,
        "writer_message": writer_message,
        "writer_error": writer_error,
        "fallback_used": fallback_used,
        "max_sentences": max_sentences,
        "pre_clamp": pre_clamp,
        "delivered": delivered,
        "clamped": bool(pre_clamp and delivered != pre_clamp),
        "response_stats": response_stats(response),
    }


async def run(args: argparse.Namespace) -> int:
    config = load_config()
    provider = create_tier2_judge_provider(config.tier2)
    if provider is None or not hasattr(provider, "_post_chat"):
        raise RuntimeError("Tier 2 Ollama-compatible provider is not configured")

    persona_set = load_personas(config.delivery.personas_file)
    selected_personas = [
        (key, persona)
        for key, persona in persona_set.personas.items()
        if not args.persona or key in args.persona
    ]
    selected_scenarios = [
        scenario for scenario in SCENARIOS if not args.scenario or scenario["id"] in args.scenario
    ]
    jobs = [
        (persona_key, persona, scenario)
        for persona_key, persona in selected_personas
        for scenario in selected_scenarios
    ]
    semaphore = asyncio.Semaphore(args.concurrency)
    tasks = [
        asyncio.create_task(evaluate_one(provider, key, persona, scenario, semaphore))
        for key, persona, scenario in jobs
    ]
    results: list[dict[str, object]] = []
    for completed, task in enumerate(asyncio.as_completed(tasks), start=1):
        result = await task
        results.append(result)
        if result["fallback_used"]:
            status = "FALLBACK"
        elif result["clamped"]:
            status = "CLAMPED"
        else:
            status = "OK"
        delivered = str(result["delivered"]).replace("\n", " ")[:100]
        print(
            f"[{completed:02d}/{len(tasks):02d}] {result['persona']}/{result['scenario']} "
            f"{status} {result['request_latency_seconds']}s | {delivered}",
            flush=True,
        )

    persona_order = {key: index for index, (key, _persona) in enumerate(selected_personas)}
    scenario_order = {scenario["id"]: index for index, scenario in enumerate(selected_scenarios)}
    results.sort(key=lambda item: (persona_order[str(item["persona"])], scenario_order[str(item["scenario"])]))
    summary = {
        "calls": len(results),
        "writer_delivered": sum(item["writer_message"] is not None for item in results),
        "fallback_used": sum(bool(item["fallback_used"]) for item in results),
        "clamped": sum(bool(item["clamped"]) for item in results),
        # Ollama Cloud reports done_reason "stop" even when generation dies at
        # num_predict, so budget starvation is detected by the pinned eval_count.
        "budget_pinned": sum(
            (item["response_stats"].get("eval_count") or 0)
            >= getattr(provider, "writer_max_output_tokens", 0)
            for item in results
        ),
        "mean_request_latency_seconds": round(
            sum(float(item["request_latency_seconds"]) for item in results) / max(1, len(results)), 3
        ),
    }
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "model": getattr(provider, "model", "<unknown>"),
        "provider": type(provider).__name__,
        "judge_max_output_tokens": getattr(provider, "max_output_tokens", None),
        "writer_max_output_tokens": getattr(provider, "writer_max_output_tokens", None),
        "concurrency": args.concurrency,
        "summary": summary,
        "scenarios": selected_scenarios,
        "results": results,
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    print(f"report={output_path}", flush=True)
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Live persona voice audit through the real Tier 2 Writer")
    parser.add_argument("--output", default="docs/benchmarks/persona-voice-v5/results.json")
    parser.add_argument("--concurrency", type=int, default=3)
    parser.add_argument("--persona", action="append", help="Persona key to include (repeatable)")
    parser.add_argument("--scenario", action="append", help="Scenario id to include (repeatable)")
    args = parser.parse_args()
    if args.concurrency < 1:
        parser.error("--concurrency must be at least 1")
    return args


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run(parse_args())))
