import asyncio
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from apps.server.app.providers.judges.base import ProviderResponseError
from apps.server.app.providers.judges.ollama_chat import (
    OllamaChatJudgeProvider,
    _message_content as ollama_message_content,
    _response_json as ollama_response_json,
)
from apps.server.app.providers.judges.openai_compatible import (
    OpenAICompatibleJudgeProvider,
    _openai_message_content,
    _response_json as openai_response_json,
)


VALID_DECISION = '{"decision":"notify","reason_code":"off_goal","basis":"both"}'


class ProviderResponseFailureTest(unittest.TestCase):
    def test_http_body_and_envelope_failures_are_distinct_for_both_styles(self) -> None:
        response = httpx.Response(200, text="upstream proxy error")
        for loader in (openai_response_json, ollama_response_json):
            with self.subTest(loader=loader.__module__), self.assertRaises(ProviderResponseError) as caught:
                loader(response)
            self.assertEqual(caught.exception.stage, "http_json")

        for extract, payload in ((_openai_message_content, {}), (ollama_message_content, {})):
            with self.subTest(extract=extract.__module__), self.assertRaises(ProviderResponseError) as caught:
                extract(payload)
            self.assertEqual(caught.exception.stage, "envelope")

    def test_openai_judge_classifies_content_schema_and_output_failures(self) -> None:
        provider = OpenAICompatibleJudgeProvider(
            base_url="https://api.example.com/v1",
            api_key="test",
            model="model",
            max_output_tokens=64,
        )
        cases = [
            ("not json", None, "content_json"),
            ('{"decision":"maybe","reason_code":"off_goal","basis":"both"}', None, "schema"),
            ('{"decision":"notify"', "length", "output_exhausted"),
        ]
        for content, finish_reason, expected_stage in cases:
            response = _openai_response(content, finish_reason)
            with (
                self.subTest(stage=expected_stage),
                patch.object(
                    OpenAICompatibleJudgeProvider,
                    "_post_chat_completions",
                    new_callable=AsyncMock,
                    return_value=response,
                ),
                self.assertRaises(ProviderResponseError) as caught,
            ):
                asyncio.run(provider.decide_tier2({"goal": "test"}, "judge"))
            self.assertEqual(caught.exception.stage, expected_stage)

    def test_ollama_judge_classifies_content_schema_and_output_failures(self) -> None:
        provider = OllamaChatJudgeProvider(
            api_url="https://ollama.com/api/chat",
            api_key="test",
            model="model",
            max_output_tokens=64,
        )
        cases = [
            ({"message": {"content": "not json"}}, "content_json"),
            (
                {"message": {"content": '{"decision":"maybe","reason_code":"off_goal","basis":"both"}'}},
                "schema",
            ),
            (
                {"message": {"content": '{"decision":"notify"'}, "done_reason": "length", "eval_count": 64},
                "output_exhausted",
            ),
        ]
        for response, expected_stage in cases:
            with (
                self.subTest(stage=expected_stage),
                patch.object(
                    OllamaChatJudgeProvider,
                    "_post_chat",
                    new_callable=AsyncMock,
                    return_value=response,
                ),
                self.assertRaises(ProviderResponseError) as caught,
            ):
                asyncio.run(provider.decide_tier2({"goal": "test"}, "judge"))
            self.assertEqual(caught.exception.stage, expected_stage)

    def test_valid_judge_decision_survives_length_signal_for_both_styles(self) -> None:
        openai = OpenAICompatibleJudgeProvider(
            base_url="https://api.example.com/v1",
            api_key="test",
            model="model",
            max_output_tokens=64,
        )
        with patch.object(
            OpenAICompatibleJudgeProvider,
            "_post_chat_completions",
            new_callable=AsyncMock,
            return_value=_openai_response(VALID_DECISION, "length"),
        ):
            openai_decision = asyncio.run(openai.decide_tier2({"goal": "test"}, "judge"))

        ollama = OllamaChatJudgeProvider(
            api_url="https://ollama.com/api/chat",
            api_key="test",
            model="model",
            max_output_tokens=64,
        )
        with patch.object(
            OllamaChatJudgeProvider,
            "_post_chat",
            new_callable=AsyncMock,
            return_value={
                "message": {"content": VALID_DECISION},
                "done_reason": "length",
                "eval_count": 64,
            },
        ):
            ollama_decision = asyncio.run(ollama.decide_tier2({"goal": "test"}, "judge"))

        self.assertEqual(openai_decision.decision, "notify")
        self.assertEqual(ollama_decision.decision, "notify")

    def test_writers_distinguish_output_exhaustion_from_empty_content(self) -> None:
        openai = OpenAICompatibleJudgeProvider(
            base_url="https://api.example.com/v1",
            api_key="test",
            model="model",
        )
        openai_cases = [
            (_openai_response("cut off", "length"), "output_exhausted"),
            (_openai_response("   ", "stop"), "writer_empty"),
        ]
        for response, expected_stage in openai_cases:
            with (
                self.subTest(style="openai", stage=expected_stage),
                patch.object(
                    OpenAICompatibleJudgeProvider,
                    "_post_chat_completions",
                    new_callable=AsyncMock,
                    return_value=response,
                ),
                self.assertRaises(ProviderResponseError) as caught,
            ):
                asyncio.run(openai.write_tier2_message({"goal": "test"}, "writer"))
            self.assertEqual(caught.exception.stage, expected_stage)

        ollama = OllamaChatJudgeProvider(
            api_url="https://ollama.com/api/chat",
            api_key="test",
            model="model",
        )
        ollama_cases = [
            (
                {"message": {"content": "cut off"}, "done_reason": "length"},
                "output_exhausted",
            ),
            ({"message": {"content": "   "}}, "writer_empty"),
        ]
        for response, expected_stage in ollama_cases:
            with (
                self.subTest(style="ollama", stage=expected_stage),
                patch.object(
                    OllamaChatJudgeProvider,
                    "_post_chat",
                    new_callable=AsyncMock,
                    return_value=response,
                ),
                self.assertRaises(ProviderResponseError) as caught,
            ):
                asyncio.run(ollama.write_tier2_message({"goal": "test"}, "writer"))
            self.assertEqual(caught.exception.stage, expected_stage)

    def test_openai_tier1_sends_and_honors_output_budget(self) -> None:
        provider = OpenAICompatibleJudgeProvider(
            base_url="https://api.example.com/v1",
            api_key="test",
            model="model",
            max_output_tokens=96,
        )
        response = _openai_response('{"verdict":"ok","reason":"relevant"}', "stop")
        with patch.object(
            OpenAICompatibleJudgeProvider,
            "_post_chat_completions",
            new_callable=AsyncMock,
            return_value=response,
        ) as post:
            result = asyncio.run(provider.classify_tier1({"goal": "test"}))

        self.assertEqual(result.verdict.value, "OK")
        self.assertEqual(post.await_args.args[0]["max_tokens"], 96)


def _openai_response(content: str, finish_reason: str | None) -> httpx.Response:
    return httpx.Response(
        200,
        request=httpx.Request("POST", "https://api.example.com/v1/chat/completions"),
        json={
            "choices": [
                {
                    "message": {"content": content},
                    "finish_reason": finish_reason,
                }
            ]
        },
    )


if __name__ == "__main__":
    unittest.main()
