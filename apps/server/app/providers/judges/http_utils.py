from __future__ import annotations

import json

import httpx


MAX_JUDGE_RESPONSE_BYTES = 1024 * 1024


async def read_bounded_json_object(
    response: httpx.Response,
    *,
    max_bytes: int = MAX_JUDGE_RESPONSE_BYTES,
) -> dict[str, object]:
    content = bytearray()
    async for chunk in response.aiter_bytes():
        content.extend(chunk)
        if len(content) > max_bytes:
            raise ValueError("judge provider response exceeded the size limit")
    value = json.loads(content)
    if not isinstance(value, dict):
        raise ValueError("judge provider response must be a JSON object")
    return value
