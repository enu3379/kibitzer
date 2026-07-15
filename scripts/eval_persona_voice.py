#!/usr/bin/env python3
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
    compose_tier2_system_prompt,
    format_persona_fallback,
    load_personas,
)
from apps.server.app.providers.judges.factory import create_tier2_judge_provider
from apps.server.app.providers.judges.ollama_chat import _message_content
from apps.server.app.providers.judges.openai_compatible import parse_tier2_json


SCENARIOS: list[dict[str, Any]] = [
    {
        "id": "S1",
        "label": "논문 조사 중 유튜브 침착맨 (첫 알림)",
        "goal": "졸업논문 선행연구 조사",
        "title": "침착맨 삼국지 3시간 풀버전",
        "host": "youtube.com",
        "excerpt": "침착맨 삼국지 3시간 풀버전. 조회수 182만 회, 댓글 3,472개.",
        "recent": [
            {"title": "RISS 학술연구정보서비스", "verdict": "OK"},
            {"title": "Google Scholar 선행연구 검색", "verdict": "OK"},
        ],
        "prior_nag_count": 0,
        "last_nag_ignored": False,
        "drift_minutes": 6,
        "repeat_host": False,
    },
    {
        "id": "S2",
        "label": "이력서 중 쿠팡 (세 번째 알림·직전 무시)",
        "goal": "노션 이력서 완성",
        "title": "기계식 키보드 로켓배송 특가",
        "host": "coupang.com",
        "excerpt": "기계식 키보드 특가 상품. 가격 89,000원, 오늘 주문 시 내일 도착.",
        "recent": [
            {"title": "Notion 이력서", "verdict": "OK"},
            {"title": "기계식 키보드 로켓배송 특가", "verdict": "DRIFT"},
        ],
        "prior_nag_count": 2,
        "last_nag_ignored": True,
        "drift_minutes": 14,
        "repeat_host": True,
    },
    {
        "id": "S3",
        "label": "리팩토링 중 게임 패치노트 (그럴싸한 딴짓)",
        "goal": "FastAPI 예외 핸들링 리팩토링",
        "title": "몬스터헌터 대검 밸런스 조정 패치노트",
        "host": "inven.co.kr",
        "excerpt": "대검 모아베기 피해량 8% 상향과 신규 장비 밸런스 조정 내용.",
        "recent": [
            {"title": "FastAPI exception handlers", "verdict": "OK"},
            {"title": "몬스터헌터 패치노트", "verdict": "DRIFT"},
        ],
        "prior_nag_count": 1,
        "last_nag_ignored": False,
        "drift_minutes": 9,
        "repeat_host": True,
    },
    {
        "id": "S4",
        "label": "발표자료 중 넷플릭스 (25분·직전 무시)",
        "goal": "Google Slides 발표자료 완성",
        "title": "흑백요리사 4화",
        "host": "netflix.com",
        "excerpt": "흑백요리사 4화 재생 중. 다음 화 자동 재생까지 15초.",
        "recent": [
            {"title": "Google Slides 발표자료 v3", "verdict": "OK"},
            {"title": "흑백요리사 3화", "verdict": "DRIFT"},
        ],
        "prior_nag_count": 1,
        "last_nag_ignored": True,
        "drift_minutes": 25,
        "repeat_host": True,
    },
    {
        "id": "S5",
        "label": "자격증 공부 중 더쿠 (첫 알림)",
        "goal": "정보처리기사 실기 공부",
        "title": "요즘 유행하는 6500원 쿠키 가격 논란",
        "host": "theqoo.net",
        "excerpt": "쿠키 한 개 6,500원의 원가와 디저트 가격을 두고 이어진 댓글 토론.",
        "recent": [{"title": "정보처리기사 실기 기출문제", "verdict": "OK"}],
        "prior_nag_count": 0,
        "last_nag_ignored": False,
        "drift_minutes": 4,
        "repeat_host": False,
    },
]


def build_payload(scenario: dict[str, Any]) -> dict[str, object]:
    return {
        "goal": scenario["goal"],
        "current": {
            "title": scenario["title"],
            "url_host": scenario["host"],
            "verdict": "DRIFT",
            "tier_reached": 2,
            "tier0_score": 0.1,
        },
        "recent": scenario["recent"],
        "page_excerpt": scenario["excerpt"],
        "nagging_context": {
            "nag_count_today": scenario["prior_nag_count"],
            "last_nag_ignored": scenario["last_nag_ignored"],
            "drift_minutes": scenario["drift_minutes"],
            "repeat_host": scenario["repeat_host"],
        },
    }


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
    payload = build_payload(scenario)
    max_sentences = persona.max_sentences or 2
    queued_at = time.monotonic()
    queue_wait_seconds = 0.0
    request_latency_seconds = 0.0
    raw_content = ""
    response: dict[str, object] = {}
    strict_json = False
    recovered_json = False
    parse_error: str | None = None
    network_error: str | None = None
    confirm_drift: bool | None = None
    parsed_message: str | None = None
    fallback_used = False

    try:
        async with semaphore:
            request_started = time.monotonic()
            queue_wait_seconds = request_started - queued_at
            response = await provider._post_chat(
                [
                    {"role": "system", "content": compose_tier2_system_prompt(persona)},
                    {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
                ]
            )
            request_latency_seconds = time.monotonic() - request_started
        raw_content = _message_content(response)
        try:
            strict_json = isinstance(json.loads(raw_content), dict)
        except (json.JSONDecodeError, TypeError):
            strict_json = False
        try:
            parsed = parse_tier2_json(raw_content)
            recovered_json = not strict_json
            confirm_drift = parsed.confirm_drift
            parsed_message = parsed.message
        except Exception as exc:  # Mirrors the server's provider-error fallback.
            parse_error = f"{type(exc).__name__}: {exc}"
            fallback_used = True
    except Exception as exc:
        network_error = f"{type(exc).__name__}: {exc}"
        fallback_used = True

    if fallback_used:
        pre_clamp = fallback_for(persona, scenario)
    elif confirm_drift:
        pre_clamp = parsed_message or ""
    else:
        pre_clamp = ""
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
        "strict_json": strict_json,
        "recovered_json": recovered_json,
        "parse_error": parse_error,
        "network_error": network_error,
        "confirm_drift": confirm_drift,
        "parsed_message": parsed_message,
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
        elif result["confirm_drift"] is False:
            status = "MISSED"
        elif result["clamped"]:
            status = "CLAMPED"
        elif result["recovered_json"]:
            status = "RECOVERED"
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
        "confirmed_drift": sum(item["confirm_drift"] is True for item in results),
        "missed_drift": sum(item["confirm_drift"] is False for item in results),
        "strict_json": sum(bool(item["strict_json"]) for item in results),
        "recovered_json": sum(bool(item["recovered_json"]) for item in results),
        "fallback_used": sum(bool(item["fallback_used"]) for item in results),
        "clamped": sum(bool(item["clamped"]) for item in results),
        "mean_request_latency_seconds": round(
            sum(float(item["request_latency_seconds"]) for item in results) / max(1, len(results)), 3
        ),
    }
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "model": getattr(provider, "model", "<unknown>"),
        "provider": type(provider).__name__,
        "max_output_tokens": getattr(provider, "max_output_tokens", None),
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
    parser = argparse.ArgumentParser(description="Live persona voice audit through the real Tier 2 provider")
    parser.add_argument("--output", default="docs/benchmarks/persona-voice-v4/results.json")
    parser.add_argument("--concurrency", type=int, default=3)
    parser.add_argument("--persona", action="append", help="Persona key to include (repeatable)")
    parser.add_argument("--scenario", action="append", help="Scenario id to include (repeatable)")
    return parser.parse_args()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run(parse_args())))
