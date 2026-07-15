from __future__ import annotations

import json
from dataclasses import dataclass, field
from itertools import count
from typing import Iterator

import httpx

from ...schemas import Verdict
from .base import (
    TIER2_JUDGE_SYSTEM_PROMPT,
    TIER2_LEGACY_SYSTEM_PROMPT,
    Tier1Result,
    Tier2Decision,
    Tier2Result,
    ordered_api_keys,
)


@dataclass(frozen=True)
class OpenAICompatibleJudgeProvider:
    base_url: str
    api_key: str
    model: str
    timeout_seconds: float = 3
    fallback_api_key: str | None = None
    max_output_tokens: int = 512
    writer_max_output_tokens: int = 1024
    # Optional rotation pool: when set (>= 2 keys), each call starts from the
    # next key in the pool and the rest queue up as fallbacks.
    api_keys: tuple[str, ...] | None = None
    _rotation: Iterator[int] = field(default_factory=count, init=False, repr=False, compare=False)

    async def classify_tier1(self, payload: dict[str, object]) -> Tier1Result:
        request_body = {
            "model": self.model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "Classify whether the current browser navigation is aligned with the user's declared "
                        "goal. Treat direct relevance and normal subtopics as ok. The declared goal includes "
                        "any goal.derived_phrases; titles matching them are goal-related even when they share "
                        "no words with the raw goal. Return strict JSON only: "
                        '{"verdict":"ok|drift","reason":"<10 words>"}.'
                    ),
                },
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            ],
            "temperature": 0,
            "response_format": {"type": "json_object"},
        }
        response = await self._post_chat_completions(request_body)
        content = response.json()["choices"][0]["message"]["content"]
        return parse_tier1_json(content)

    async def complete_goal_enrichment(self, prompt: str, timeout_seconds: float) -> str:
        request_body = {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0,
            "response_format": {"type": "json_object"},
        }
        response = await self._post_chat_completions(request_body, timeout_seconds=timeout_seconds)
        return response.json()["choices"][0]["message"]["content"]

    async def confirm_tier2(
        self,
        payload: dict[str, object],
        system_prompt: str | None = None,
    ) -> Tier2Result:
        request_body = {
            "model": self.model,
            "messages": _tier2_messages(payload, system_prompt),
            "temperature": 0,
            "max_tokens": self.max_output_tokens,
            "response_format": {"type": "json_object"},
        }
        response = await self._post_chat_completions(request_body)
        content = response.json()["choices"][0]["message"]["content"]
        return parse_tier2_json(content)

    async def decide_tier2(
        self,
        payload: dict[str, object],
        system_prompt: str | None = None,
    ) -> Tier2Decision:
        request_body = {
            "model": self.model,
            "messages": _tier2_judge_messages(payload, system_prompt),
            "temperature": 0,
            "max_tokens": self.max_output_tokens,
            "response_format": {"type": "json_object"},
        }
        response = await self._post_chat_completions(request_body)
        return parse_tier2_decision_json(_openai_message_content(response.json()))

    async def write_tier2_message(
        self,
        payload: dict[str, object],
        system_prompt: str,
    ) -> str:
        request_body = {
            "model": self.model,
            "messages": _tier2_writer_messages(payload, system_prompt),
            "temperature": 0,
            "max_tokens": self.writer_max_output_tokens,
        }
        response = await self._post_chat_completions(request_body)
        response_data = response.json()
        if _openai_finish_reason(response_data) == "length":
            raise ValueError("tier2 writer response exhausted output budget")
        content = _openai_message_content(response_data).strip()
        if not content:
            raise ValueError("tier2 writer response was empty")
        return content[:320]

    async def _post_chat_completions(
        self,
        request_body: dict[str, object],
        timeout_seconds: float | None = None,
    ) -> httpx.Response:
        url = _chat_completions_url(self.base_url)
        api_keys = ordered_api_keys(self.api_keys, self.api_key, self.fallback_api_key, self._rotation)

        last_response: httpx.Response | None = None
        async with httpx.AsyncClient(timeout=timeout_seconds or self.timeout_seconds) as client:
            for index, api_key in enumerate(api_keys):
                headers = {"authorization": f"Bearer {api_key}", "content-type": "application/json"}
                response = await client.post(url, headers=headers, json=request_body)
                last_response = response
                if response.status_code in {401, 403, 429} and index + 1 < len(api_keys):
                    continue
                response.raise_for_status()
                return response

        assert last_response is not None
        last_response.raise_for_status()
        return last_response


def parse_tier1_json(content: str) -> Tier1Result:
    data = _load_json_object(content)
    verdict = str(data.get("verdict", "")).lower()
    reason = str(data.get("reason", "")).strip()[:80] or "no reason"
    if verdict == "ok":
        return Tier1Result(verdict=Verdict.OK, reason=reason)
    if verdict == "drift":
        return Tier1Result(verdict=Verdict.DRIFT, reason=reason)
    raise ValueError(f"invalid tier1 verdict: {verdict}")


def parse_tier2_json(content: str) -> Tier2Result:
    data = _load_json_object(content)
    confirm = data.get("confirm_drift")
    if not isinstance(confirm, bool):
        raise ValueError("tier2 confirm_drift must be boolean")
    message_value = data.get("message")
    message = str(message_value).strip()[:320] if message_value is not None else None
    if confirm and not message:
        message = "지금 보고 있는 페이지가 현재 목표에서 벗어난 것 같습니다. 계속 필요한 흐름인지 확인해볼까요?"
    return Tier2Result(confirm_drift=confirm, message=message)


def parse_tier2_decision_json(content: str) -> Tier2Decision:
    data = _load_json_object(content)
    decision = data.get("decision")
    reason_code = data.get("reason_code")
    basis = data.get("basis")
    if decision not in {"notify", "defer"}:
        raise ValueError("tier2 decision must be notify or defer")
    if reason_code not in {"off_goal", "useful_side_branch", "insufficient_evidence"}:
        raise ValueError("tier2 reason_code is invalid")
    if basis not in {"title", "content", "both"}:
        raise ValueError("tier2 basis is invalid")
    return Tier2Decision(decision=decision, reason_code=reason_code, basis=basis)


def _tier2_messages(
    payload: dict[str, object],
    system_prompt: str | None = None,
) -> list[dict[str, str]]:
    return [
        {
            "role": "system",
            "content": system_prompt or TIER2_LEGACY_SYSTEM_PROMPT,
        },
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
    ]


def _tier2_judge_messages(
    payload: dict[str, object],
    system_prompt: str | None,
) -> list[dict[str, str]]:
    return [
        {
            "role": "system",
            "content": system_prompt or TIER2_JUDGE_SYSTEM_PROMPT,
        },
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
    ]


def _tier2_writer_messages(
    payload: dict[str, object],
    system_prompt: str,
) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
    ]


def _openai_message_content(response: dict[str, object]) -> str:
    choices = response.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise ValueError("OpenAI response did not include choices")
    message = choices[0].get("message")
    if not isinstance(message, dict) or not isinstance(message.get("content"), str):
        raise ValueError("OpenAI response did not include message content")
    return message["content"]


def _openai_finish_reason(response: dict[str, object]) -> str | None:
    choices = response.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return None
    finish_reason = choices[0].get("finish_reason")
    return finish_reason if isinstance(finish_reason, str) else None


def _chat_completions_url(base_url: str) -> str:
    base = base_url.rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    return f"{base}/chat/completions"


def _load_json_object(content: str) -> dict[str, object]:
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        start = content.find("{")
        end = content.rfind("}")
        if start == -1 or end <= start:
            raise
        data = json.loads(content[start : end + 1])
    if not isinstance(data, dict):
        raise ValueError("judge response must be a JSON object")
    return data
