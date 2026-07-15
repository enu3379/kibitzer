from __future__ import annotations

import json
from dataclasses import dataclass, field
from itertools import count
from typing import Iterator

import httpx

from .base import Tier1Result, Tier2Result, ordered_api_keys
from .http_utils import read_bounded_json_object
from .openai_compatible import parse_tier1_json, parse_tier2_json


# Output budgets for the one-shot goal-enrichment call: with thinking disabled
# the response is tiny; models that reject the flag need room for reasoning
# before the JSON content.
_GOAL_ENRICHMENT_NUM_PREDICT = 512
_GOAL_ENRICHMENT_THINKING_NUM_PREDICT = 2048


@dataclass(frozen=True)
class OllamaChatJudgeProvider:
    api_url: str
    api_key: str
    model: str
    timeout_seconds: float = 120
    fallback_api_key: str | None = None
    max_output_tokens: int = 512
    # Optional rotation pool: when set (>= 2 keys), each call starts from the
    # next key in the pool and the rest queue up as fallbacks.
    api_keys: tuple[str, ...] | None = None
    _rotation: Iterator[int] = field(default_factory=count, init=False, repr=False, compare=False)

    async def classify_tier1(self, payload: dict[str, object]) -> Tier1Result:
        response = await self._post_chat(
            [
                {
                    "role": "system",
                    "content": (
                        "Classify whether the current browser navigation is aligned with the user's declared "
                        "goal. The declared goal includes any goal.derived_phrases; titles matching them are "
                        "goal-related even when they share no words with the raw goal. Return strict JSON only: "
                        '{"verdict":"ok|drift","reason":"<10 words>"}.'
                    ),
                },
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            ]
        )
        return parse_tier1_json(_message_content(response))

    async def complete_goal_enrichment(self, prompt: str, timeout_seconds: float) -> str:
        messages = [{"role": "user", "content": prompt}]
        try:
            response = await self._post_chat(
                messages,
                timeout_seconds=timeout_seconds,
                think=False,
                num_predict=_GOAL_ENRICHMENT_NUM_PREDICT,
            )
        except httpx.HTTPStatusError:
            response = await self._post_chat(
                messages,
                timeout_seconds=timeout_seconds,
                num_predict=_GOAL_ENRICHMENT_THINKING_NUM_PREDICT,
            )
        return _message_content(response)

    async def confirm_tier2(
        self,
        payload: dict[str, object],
        system_prompt: str | None = None,
    ) -> Tier2Result:
        response = await self._post_chat(
            [
                {
                    "role": "system",
                    "content": system_prompt or (
                        "You are Kibitzer, a quiet browser drift guard. Decide whether the page excerpt is "
                        "truly off-goal. Return strict JSON only: "
                        '{"confirm_drift":true|false,"message":"<=2 short Korean sentences if true, else empty string"}.'
                    ),
                },
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            ]
        )
        return parse_tier2_json(_message_content(response))

    async def _post_chat(
        self,
        messages: list[dict[str, str]],
        timeout_seconds: float | None = None,
        think: bool | None = None,
        num_predict: int | None = None,
    ) -> dict[str, object]:
        request_body: dict[str, object] = {
            "model": self.model,
            "messages": messages,
            "stream": False,
            "format": "json",
            "options": {"temperature": 0, "num_predict": num_predict or self.max_output_tokens},
        }
        if think is not None:
            request_body["think"] = think
        api_keys = ordered_api_keys(self.api_keys, self.api_key, self.fallback_api_key, self._rotation)

        last_response: httpx.Response | None = None
        async with httpx.AsyncClient(timeout=timeout_seconds or self.timeout_seconds) as client:
            for index, api_key in enumerate(api_keys):
                async with client.stream(
                    "POST",
                    self.api_url,
                    headers={"authorization": f"Bearer {api_key}", "content-type": "application/json"},
                    json=request_body,
                ) as response:
                    last_response = response
                    if response.status_code in {401, 403, 429} and index + 1 < len(api_keys):
                        continue
                    response.raise_for_status()
                    return await read_bounded_json_object(response)

        assert last_response is not None
        last_response.raise_for_status()
        raise RuntimeError("judge provider request completed without a response")


def _message_content(response: dict[str, object]) -> str:
    message = response.get("message")
    if isinstance(message, dict):
        content = message.get("content")
        if isinstance(content, str):
            return content
    response_text = response.get("response")
    if isinstance(response_text, str):
        return response_text
    raise ValueError("Ollama response did not include message content")
