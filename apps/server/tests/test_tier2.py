import asyncio
import json
import sqlite3
import tempfile
import unittest
import uuid
from contextlib import closing
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
import yaml
from apps.server.tests.support import TestClient

from apps.server.app.config import (
    AppConfig,
    ControllerConfig,
    DeliveryConfig,
    DwellConfig,
    QuietHoursConfig,
    ServerConfig,
    Tier1Config,
    Tier2Config,
    VoiceConfig,
)
from apps.server.app.main import create_app
from apps.server.app.core.tier2_payload import compress_recent_titles
from apps.server.app.providers.judges.base import Tier1Result, Tier2Decision, Tier2Result
from apps.server.app.providers.judges.factory import create_tier2_judge_provider
from apps.server.app.providers.judges.ollama_chat import OllamaChatJudgeProvider
from apps.server.app.providers.judges.openai_compatible import (
    OpenAICompatibleJudgeProvider,
    parse_tier2_decision_json,
    parse_tier2_json,
)
from apps.server.app.schemas import Observation, ObservationFeatures, Source, Verdict
from apps.server.app.storage.sqlite import ObservationSummary, SQLiteStore


@dataclass
class FakeTier2Provider:
    result: Tier2Result
    payloads: list[dict[str, object]] = field(default_factory=list)
    system_prompts: list[str | None] = field(default_factory=list)
    writer_payloads: list[dict[str, object]] = field(default_factory=list)
    writer_system_prompts: list[str] = field(default_factory=list)

    async def classify_tier1(self, payload: dict[str, object]) -> Tier1Result:
        return Tier1Result(verdict=Verdict.DRIFT, reason="unused")

    async def confirm_tier2(
        self,
        payload: dict[str, object],
        system_prompt: str | None = None,
    ) -> Tier2Result:
        self.payloads.append(payload)
        self.system_prompts.append(system_prompt)
        return self.result

    async def decide_tier2(
        self,
        payload: dict[str, object],
        system_prompt: str | None = None,
    ) -> Tier2Decision:
        self.payloads.append(payload)
        self.system_prompts.append(system_prompt)
        return Tier2Decision(
            decision="notify" if self.result.confirm_drift else "defer",
            reason_code="off_goal" if self.result.confirm_drift else "useful_side_branch",
            basis="both",
        )

    async def write_tier2_message(
        self,
        payload: dict[str, object],
        system_prompt: str,
    ) -> str:
        self.writer_payloads.append(payload)
        self.writer_system_prompts.append(system_prompt)
        return self.result.message or ""


class RaisingTier2Provider:
    async def classify_tier1(self, payload: dict[str, object]) -> Tier1Result:
        return Tier1Result(verdict=Verdict.DRIFT, reason="unused")

    async def confirm_tier2(
        self,
        payload: dict[str, object],
        system_prompt: str | None = None,
    ) -> Tier2Result:
        request = httpx.Request("POST", "https://provider.invalid/chat")
        raise httpx.ConnectError("offline", request=request)

    async def decide_tier2(
        self,
        payload: dict[str, object],
        system_prompt: str | None = None,
    ) -> Tier2Decision:
        request = httpx.Request("POST", "https://provider.invalid/chat")
        raise httpx.ConnectError("offline", request=request)

    async def write_tier2_message(
        self,
        payload: dict[str, object],
        system_prompt: str,
    ) -> str:
        raise AssertionError("writer must not run after judge failure")


class Tier2ProviderTest(unittest.TestCase):
    def test_tier2_defaults_to_thirty_titles_and_compresses_consecutive_duplicates(self) -> None:
        self.assertEqual(Tier2Config().recent_observations, 30)
        compressed = compress_recent_titles(
            [
                ObservationSummary(title="Docs", verdict="OK"),
                ObservationSummary(title="Docs", verdict="OK"),
                ObservationSummary(title="Social", verdict="DRIFT"),
                ObservationSummary(title="Docs", verdict="OK"),
            ]
        )
        self.assertEqual(
            compressed,
            [
                {"title": "Docs", "verdict": "OK", "repeat_count": 2},
                {"title": "Social", "verdict": "DRIFT", "repeat_count": 1},
                {"title": "Docs", "verdict": "OK", "repeat_count": 1},
            ],
        )

    def test_parse_tier2_json_accepts_confirm_and_cancel(self) -> None:
        confirm = parse_tier2_json('{"confirm_drift":true,"message":"목표에서 벗어났습니다."}')
        cancel = parse_tier2_json('{"confirm_drift":false,"message":""}')
        fenced = parse_tier2_json('```json\n{"confirm_drift":true,"message":"다른 흐름입니다."}\n```')

        self.assertTrue(confirm.confirm_drift)
        self.assertEqual(confirm.message, "목표에서 벗어났습니다.")
        self.assertFalse(cancel.confirm_drift)
        self.assertEqual(fenced.message, "다른 흐름입니다.")

    def test_parse_tier2_json_rejects_non_boolean_confirm(self) -> None:
        with self.assertRaises(ValueError):
            parse_tier2_json('{"confirm_drift":"yes","message":"bad"}')

    def test_parse_tier2_decision_accepts_fenced_json_and_rejects_unknown_enums(self) -> None:
        decision = parse_tier2_decision_json(
            '```json\n{"decision":"defer","reason_code":"useful_side_branch","basis":"content"}\n```'
        )
        self.assertEqual(decision.decision, "defer")
        self.assertEqual(decision.reason_code, "useful_side_branch")
        self.assertEqual(decision.basis, "content")
        with self.assertRaises(ValueError):
            parse_tier2_decision_json(
                '{"decision":"maybe","reason_code":"off_goal","basis":"both"}'
            )

    def test_openai_provider_uses_json_4096_judge_and_plain_1024_writer(self) -> None:
        provider = OpenAICompatibleJudgeProvider(
            base_url="https://api.example.com/v1",
            api_key="test",
            model="model",
            max_output_tokens=4096,
            writer_max_output_tokens=1024,
        )
        judge_response = httpx.Response(
            200,
            request=httpx.Request("POST", "https://api.example.com/v1/chat/completions"),
            json={
                "choices": [
                    {
                        "message": {
                            "content": '{"decision":"notify","reason_code":"off_goal","basis":"both"}'
                        }
                    }
                ]
            },
        )
        writer_response = httpx.Response(
            200,
            request=httpx.Request("POST", "https://api.example.com/v1/chat/completions"),
            json={"choices": [{"message": {"content": "짧은 훈수입니다."}}]},
        )
        with patch.object(
            OpenAICompatibleJudgeProvider,
            "_post_chat_completions",
            new_callable=AsyncMock,
            side_effect=[judge_response, writer_response],
        ) as post:
            decision = asyncio.run(provider.decide_tier2({"goal": "test"}, "judge"))
            message = asyncio.run(provider.write_tier2_message({"goal": "test"}, "writer"))

        self.assertEqual(decision.decision, "notify")
        self.assertEqual(message, "짧은 훈수입니다.")
        judge_body = post.await_args_list[0].args[0]
        writer_body = post.await_args_list[1].args[0]
        self.assertEqual(judge_body["max_tokens"], 4096)
        self.assertEqual(judge_body["response_format"], {"type": "json_object"})
        self.assertEqual(writer_body["max_tokens"], 1024)
        self.assertNotIn("response_format", writer_body)

    def test_ollama_provider_uses_json_judge_and_plain_nonthinking_writer(self) -> None:
        provider = OllamaChatJudgeProvider(
            api_url="https://ollama.com/api/chat",
            api_key="test",
            model="model",
            max_output_tokens=4096,
            writer_max_output_tokens=1024,
        )
        with patch.object(
            OllamaChatJudgeProvider,
            "_post_chat",
            new_callable=AsyncMock,
            side_effect=[
                {"message": {"content": '{"decision":"notify","reason_code":"off_goal","basis":"both"}'}},
                {"message": {"content": "짧은 훈수입니다."}},
            ],
        ) as post:
            asyncio.run(provider.decide_tier2({"goal": "test"}, "judge"))
            asyncio.run(provider.write_tier2_message({"goal": "test"}, "writer"))

        judge_kwargs = post.await_args_list[0].kwargs
        writer_kwargs = post.await_args_list[1].kwargs
        self.assertEqual(judge_kwargs["num_predict"], 4096)
        self.assertTrue(judge_kwargs["json_mode"])
        self.assertEqual(writer_kwargs["num_predict"], 1024)
        self.assertFalse(writer_kwargs["json_mode"])
        self.assertFalse(writer_kwargs["think"])

    def test_ollama_writer_rejects_output_pinned_to_budget_even_with_content(self) -> None:
        provider = OllamaChatJudgeProvider(
            api_url="https://ollama.com/api/chat",
            api_key="test",
            model="model",
            writer_max_output_tokens=1024,
        )
        response = {
            "message": {"content": "패치노트 구경은 잠깐 벤치 휴식이에요. 예"},
            "done_reason": "stop",
            "eval_count": 1024,
        }
        with patch.object(
            OllamaChatJudgeProvider,
            "_post_chat",
            new_callable=AsyncMock,
            return_value=response,
        ):
            with self.assertRaisesRegex(ValueError, "exhausted output budget"):
                asyncio.run(provider.write_tier2_message({"goal": "test"}, "writer"))

    def test_openai_writer_rejects_length_finish_reason(self) -> None:
        provider = OpenAICompatibleJudgeProvider(
            base_url="https://api.example.com/v1",
            api_key="test",
            model="model",
            writer_max_output_tokens=1024,
        )
        response = httpx.Response(
            200,
            request=httpx.Request("POST", "https://api.example.com/v1/chat/completions"),
            json={
                "choices": [
                    {
                        "finish_reason": "length",
                        "message": {"content": "문장 중간에서 잘린 출력"},
                    }
                ]
            },
        )
        with patch.object(
            OpenAICompatibleJudgeProvider,
            "_post_chat_completions",
            new_callable=AsyncMock,
            return_value=response,
        ):
            with self.assertRaisesRegex(ValueError, "exhausted output budget"):
                asyncio.run(provider.write_tier2_message({"goal": "test"}, "writer"))

    def test_factory_reads_ollama_experiment_model_without_copying_keys(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            models_file = Path(tmp) / "models.yaml"
            models_file.write_text(
                yaml.safe_dump(
                    {
                        "ollama_free": {
                            "api_url": "https://ollama.com/api/chat",
                            "api_style": "ollama",
                            "model_name": "qwen3.5:27b",
                            "timeout_sec": 12,
                            "max_output_tokens": 128,
                            "writer_max_output_tokens": 96,
                            "api_key": "primary-test-key",
                            "fallback_api_key": "fallback-test-key",
                        }
                    }
                )
            )

            provider = create_tier2_judge_provider(
                Tier2Config(
                    provider="experiment",
                    experiment_models_file=str(models_file),
                    experiment_model_key="ollama_free",
                )
            )

        self.assertIsInstance(provider, OllamaChatJudgeProvider)
        assert isinstance(provider, OllamaChatJudgeProvider)
        self.assertEqual(provider.model, "qwen3.5:27b")
        self.assertEqual(provider.api_url, "https://ollama.com/api/chat")
        self.assertEqual(provider.timeout_seconds, 12)
        self.assertEqual(provider.max_output_tokens, 128)
        self.assertEqual(provider.writer_max_output_tokens, 96)


class Tier2ApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "kibitzer.sqlite3"

    def tearDown(self) -> None:
        self.tmpdir.cleanup()

    def _client(
        self,
        provider: FakeTier2Provider | None,
        tier2_enabled: bool = True,
        delivery: DeliveryConfig | None = None,
        controller: ControllerConfig | None = None,
        dwell: DwellConfig | None = None,
    ) -> tuple[TestClient, SQLiteStore]:
        store = SQLiteStore(self.db_path)
        config = AppConfig(
            server=ServerConfig(db_path=str(self.db_path)),
            tier1=Tier1Config(enabled=False),
            tier2=Tier2Config(enabled=tier2_enabled, excerpt_char_limit=120, recent_observations=3),
            controller=controller or ControllerConfig(k=1, coldstart_observations=1, cooldown_seconds=0),
            delivery=delivery or DeliveryConfig(),
            dwell=dwell or DwellConfig(),
        )
        client = TestClient(create_app(config=config, store=store, tier2_provider=provider))
        client.__enter__()
        return client, store

    def _start_goal_and_request_excerpt(self, client: TestClient) -> dict[str, object]:
        client.post("/sessions")
        client.post("/sessions/current/goal", json={"raw_text": "Kibitzer observation API"})
        response = client.post(
            "/observations/browser-nav",
            json={
                "source": "browser_nav",
                "payload": {
                    "url": "https://example.com/bread?secret=not-stored",
                    "title": "Sourdough bread recipe",
                },
            },
        )
        result = response.json()
        self.assertEqual(result["action"], "request_excerpt")
        self.assertTrue(str(result["candidate_id"]).startswith("cand_"))
        return result

    def test_excerpt_confirmed_creates_notify_and_intervention_without_storing_excerpt(self) -> None:
        provider = FakeTier2Provider(Tier2Result(confirm_drift=True, message="지금 페이지는 목표와 달라 보여요. 계속 볼까요?"))
        client, store = self._client(provider)
        secret_excerpt = "DO_NOT_PERSIST_SECRET_EXCERPT"
        try:
            request = self._start_goal_and_request_excerpt(client)
            before = store.get_controller_state(store.get_current_session().session.id)
            self.assertEqual(before.streak, 1)
            self.assertIsNone(before.last_intervention_ts)
            response = client.post(
                f"/observations/{request['observation_id']}/excerpt",
                json={"title": "Bread", "text": f"{secret_excerpt} " + ("bread " * 100)},
            )
            provider_status = client.get("/health").json()["provider_calls"]["tier2"]
        finally:
            client.__exit__(None, None, None)

        result = response.json()
        self.assertEqual(result["action"], "notify")
        self.assertEqual(result["message"], "지금 페이지는 목표와 달라 보여요. 계속 볼까요?")
        self.assertTrue(result["intervention_id"].startswith("int_"))
        self.assertEqual(len(provider.payloads), 1)
        self.assertEqual(provider_status["last_result"], "success")
        self.assertIsNone(provider_status["reason"])
        payload = provider.payloads[0]
        self.assertLessEqual(len(str(payload["current"]["page_excerpt"])), 120)
        self.assertEqual(payload["current"]["url_host"], "example.com")
        self.assertNotIn("secret=not-stored", json.dumps(payload))

        with closing(sqlite3.connect(self.db_path)) as conn:
            events = "\n".join(row[0] for row in conn.execute("SELECT payload_json FROM event_log").fetchall())
            intervention_count = conn.execute("SELECT COUNT(*) FROM interventions").fetchone()[0]
        self.assertEqual(intervention_count, 1)
        self.assertNotIn(secret_excerpt, events)
        current = store.get_current_session()
        assert current is not None
        after = store.get_controller_state(current.session.id)
        self.assertEqual(after.streak, 0)
        self.assertIsNotNone(after.last_intervention_ts)
        candidate = store.get_intervention_candidate_for_observation(str(request["observation_id"]))
        self.assertIsNotNone(candidate)
        assert candidate is not None
        self.assertEqual(candidate.status, "confirmed")
        self.assertEqual(candidate.intervention_id, result["intervention_id"])

    def test_tier2_can_cancel_false_positive_drift(self) -> None:
        provider = FakeTier2Provider(Tier2Result(confirm_drift=False, message=""))
        client, store = self._client(provider)
        try:
            request = self._start_goal_and_request_excerpt(client)
            response = client.post(
                f"/observations/{request['observation_id']}/excerpt",
                json={"title": "API design", "text": "This bread page is actually an API example about breadcrumbs."},
            )
            replay = client.post(
                f"/observations/{request['observation_id']}/excerpt",
                json={"title": "API design", "text": "This bread page is actually an API example about breadcrumbs."},
            )
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(replay.status_code, 200)
        self.assertEqual(replay.json(), response.json())
        self.assertEqual(response.json()["action"], "none")
        self.assertEqual(len(provider.payloads), 1)
        self.assertEqual(len(provider.writer_payloads), 0)
        with closing(sqlite3.connect(self.db_path)) as conn:
            intervention_count = conn.execute("SELECT COUNT(*) FROM interventions").fetchone()[0]
            cancelled = conn.execute("SELECT COUNT(*) FROM event_log WHERE event_type = 'tier2.cancelled'").fetchone()[0]
        self.assertEqual(intervention_count, 0)
        self.assertEqual(cancelled, 1)
        current = store.get_current_session()
        assert current is not None
        state = store.get_controller_state(current.session.id)
        self.assertEqual(state.streak, 1)
        self.assertIsNone(state.last_intervention_ts)
        candidate = store.get_intervention_candidate_for_observation(str(request["observation_id"]))
        self.assertIsNotNone(candidate)
        assert candidate is not None
        self.assertEqual(candidate.status, "cancelled")

    def test_goal_edit_cancels_pending_excerpt_and_rejects_the_old_observation(self) -> None:
        provider = FakeTier2Provider(Tier2Result(confirm_drift=True, message="must not be used"))
        client, store = self._client(provider)
        try:
            request = self._start_goal_and_request_excerpt(client)
            goal_response = client.post(
                "/sessions/current/goal",
                json={"raw_text": "A newly revised goal"},
            )
            response = client.post(
                f"/observations/{request['observation_id']}/excerpt",
                json={"title": "Bread", "text": "Old goal excerpt."},
            )
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(goal_response.status_code, 200)
        self.assertEqual(response.status_code, 404)
        self.assertEqual(provider.payloads, [])
        candidate = store.get_intervention_candidate_for_observation(
            str(request["observation_id"])
        )
        self.assertIsNotNone(candidate)
        assert candidate is not None
        self.assertEqual(candidate.status, "cancelled")
        current = store.get_current_session()
        assert current is not None
        self.assertEqual(current.goal.goal_revision, 2)
        controller = store.get_controller_state(current.session.id)
        self.assertEqual((controller.streak, controller.obs_count), (0, 0))
        with closing(sqlite3.connect(self.db_path)) as conn:
            intervention_count = conn.execute("SELECT COUNT(*) FROM interventions").fetchone()[0]
        self.assertEqual(intervention_count, 0)

    def test_duplicate_excerpt_does_not_call_tier2_twice(self) -> None:
        provider = FakeTier2Provider(Tier2Result(confirm_drift=True, message="한 번만 심사합니다."))
        client, _store = self._client(provider)
        try:
            request = self._start_goal_and_request_excerpt(client)
            first = client.post(
                f"/observations/{request['observation_id']}/excerpt",
                json={"title": "Bread", "text": "Unrelated bread recipe."},
            )
            second = client.post(
                f"/observations/{request['observation_id']}/excerpt",
                json={"title": "Bread", "text": "Unrelated bread recipe."},
            )
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json(), first.json())
        self.assertEqual(len(provider.payloads), 1)
        with closing(sqlite3.connect(self.db_path)) as conn:
            intervention_count = conn.execute("SELECT COUNT(*) FROM interventions").fetchone()[0]
            confirmed_count = conn.execute(
                "SELECT COUNT(*) FROM event_log WHERE event_type = 'tier2.confirmed'"
            ).fetchone()[0]
        self.assertEqual(intervention_count, 1)
        self.assertEqual(confirmed_count, 1)

    def test_excerpt_retry_replays_result_when_delivery_fails_after_commit(self) -> None:
        provider = FakeTier2Provider(Tier2Result(confirm_drift=True, message="커밋 뒤 응답이 끊겼습니다."))
        client, store = self._client(provider)
        try:
            request = self._start_goal_and_request_excerpt(client)
            with patch(
                "apps.server.app.api.observations._handle_delivery_side_effects",
                side_effect=RuntimeError("synthetic response-loss window"),
            ):
                with self.assertRaises(RuntimeError):
                    client.post(
                        f"/observations/{request['observation_id']}/excerpt",
                        json={"title": "Bread", "text": "Unrelated bread recipe."},
                    )
            replay = client.post(
                f"/observations/{request['observation_id']}/excerpt",
                json={"title": "Bread", "text": "Unrelated bread recipe."},
            )
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(replay.status_code, 200)
        self.assertEqual(replay.json()["action"], "notify")
        self.assertEqual(replay.json()["message"], "커밋 뒤 응답이 끊겼습니다.")
        self.assertEqual(len(provider.payloads), 1)
        candidate = store.get_intervention_candidate_for_observation(str(request["observation_id"]))
        self.assertIsNotNone(candidate)
        assert candidate is not None
        self.assertEqual(candidate.status, "confirmed")
        with closing(sqlite3.connect(self.db_path)) as conn:
            intervention_count = conn.execute("SELECT COUNT(*) FROM interventions").fetchone()[0]
        self.assertEqual(intervention_count, 1)

    def test_failed_excerpt_processing_releases_candidate_for_retry(self) -> None:
        provider = FakeTier2Provider(Tier2Result(confirm_drift=True, message="retry me"))
        client, store = self._client(provider)
        try:
            request = self._start_goal_and_request_excerpt(client)
            with patch(
                "apps.server.app.api.observations.clamp_notification_message",
                side_effect=RuntimeError("synthetic processing failure"),
            ):
                with self.assertRaises(RuntimeError):
                    client.post(
                        f"/observations/{request['observation_id']}/excerpt",
                        json={"title": "Bread", "text": "Unrelated bread recipe."},
                    )
        finally:
            client.__exit__(None, None, None)

        candidate = store.get_intervention_candidate_for_observation(str(request["observation_id"]))
        self.assertIsNotNone(candidate)
        assert candidate is not None
        self.assertEqual(candidate.status, "pending")

    def test_confirmed_intervention_rolls_back_all_state_when_candidate_resolution_fails(self) -> None:
        provider = FakeTier2Provider(Tier2Result(confirm_drift=True, message="atomic confirmation"))
        client, store = self._client(provider)
        try:
            request = self._start_goal_and_request_excerpt(client)
            current = store.get_current_session()
            assert current is not None
            before = store.get_controller_state(current.session.id)
            with closing(sqlite3.connect(self.db_path)) as conn:
                conn.execute(
                    """
                    CREATE TRIGGER fail_candidate_confirmation
                    BEFORE UPDATE OF status ON intervention_candidates
                    WHEN NEW.status = 'confirmed'
                    BEGIN
                        SELECT RAISE(ABORT, 'synthetic candidate resolution failure');
                    END
                    """
                )
            with self.assertRaises(sqlite3.IntegrityError):
                client.post(
                    f"/observations/{request['observation_id']}/excerpt",
                    json={"title": "Bread", "text": "Unrelated bread recipe."},
                )
        finally:
            client.__exit__(None, None, None)

        after = store.get_controller_state(current.session.id)
        self.assertEqual(after.streak, before.streak)
        self.assertEqual(after.last_intervention_ts, before.last_intervention_ts)
        with closing(sqlite3.connect(self.db_path)) as conn:
            intervention_count = conn.execute("SELECT COUNT(*) FROM interventions").fetchone()[0]
        self.assertEqual(intervention_count, 0)
        candidate = store.get_intervention_candidate_for_observation(str(request["observation_id"]))
        self.assertIsNotNone(candidate)
        assert candidate is not None
        self.assertEqual(candidate.status, "pending")

    def test_alignment_evidence_is_consumed_only_after_tier2_confirmation(self) -> None:
        provider = FakeTier2Provider(Tier2Result(confirm_drift=True, message="누적 이탈을 확인했습니다."))
        client, store = self._client(
            provider,
            controller=ControllerConfig(
                type="alignment",
                alignment_alpha=0.85,
                theta_low=0.15,
                theta_high=0.3,
                coldstart_observations=1,
                cooldown_seconds=0,
            ),
        )
        try:
            request = self._start_goal_and_request_excerpt(client)
            current = store.get_current_session()
            assert current is not None
            before = store.get_controller_state(current.session.id)
            self.assertEqual(before.streak, 1)
            self.assertTrue(before.drift_latched)
            self.assertIsNone(before.last_intervention_ts)
            response = client.post(
                f"/observations/{request['observation_id']}/excerpt",
                json={"title": "Bread", "text": "Unrelated bread recipe."},
            )
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(response.status_code, 200)
        after = store.get_controller_state(current.session.id)
        self.assertEqual(after.streak, 0)
        self.assertTrue(after.drift_latched)
        self.assertIsNotNone(after.last_intervention_ts)

    def test_candidate_expiry_includes_runtime_remaining_tier2_dwell(self) -> None:
        provider = FakeTier2Provider(Tier2Result(confirm_drift=True, message="unused"))
        client, store = self._client(provider)
        try:
            store.update_settings(
                {"dwell": {"observation_seconds": 5, "tier2_seconds": 120}}
            )
            request = self._start_goal_and_request_excerpt(client)
        finally:
            client.__exit__(None, None, None)

        candidate = store.get_intervention_candidate_for_observation(str(request["observation_id"]))
        self.assertIsNotNone(candidate)
        assert candidate is not None
        self.assertEqual(int((candidate.expires_at - candidate.requested_at).total_seconds()), 175)

    def test_missing_provider_defers_without_local_judgment(self) -> None:
        client, _store = self._client(None, tier2_enabled=False)
        try:
            request = self._start_goal_and_request_excerpt(client)
            response = client.post(
                f"/observations/{request['observation_id']}/excerpt",
                json={"title": "Bread", "text": "A recipe with unrelated steps."},
            )
            provider_status = client.get("/health").json()["provider_calls"]["tier2"]
        finally:
            client.__exit__(None, None, None)

        result = response.json()
        self.assertEqual(result["action"], "none")
        self.assertIsNone(result["message"])
        self.assertEqual(provider_status["last_result"], "none")
        with closing(sqlite3.connect(self.db_path)) as conn:
            confirmed = conn.execute("SELECT COUNT(*) FROM event_log WHERE event_type = 'tier2.confirmed'").fetchone()[0]
        self.assertEqual(confirmed, 0)

    def test_provider_failure_is_reported_in_health(self) -> None:
        client, _store = self._client(RaisingTier2Provider())
        try:
            request = self._start_goal_and_request_excerpt(client)
            response = client.post(
                f"/observations/{request['observation_id']}/excerpt",
                json={"title": "Bread", "text": "A recipe with unrelated steps."},
            )
            provider_status = client.get("/health").json()["provider_calls"]["tier2"]
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(response.json()["action"], "none")
        self.assertEqual(provider_status["last_result"], "error")
        self.assertEqual(provider_status["reason"], "connection")

    def test_writer_failure_uses_fallback_and_next_success_clears_health_error(self) -> None:
        provider = FakeTier2Provider(Tier2Result(confirm_drift=True, message=""))
        client, _store = self._client(provider)
        try:
            first_request = self._start_goal_and_request_excerpt(client)
            first = client.post(
                f"/observations/{first_request['observation_id']}/excerpt",
                json={"title": "Bread", "text": "A recipe with unrelated steps."},
            ).json()
            failed_status = client.get("/health").json()["provider_calls"]["tier2"]

            provider.result = Tier2Result(confirm_drift=True, message="정상 Writer 메시지입니다.")
            second_request = client.post(
                "/observations/browser-nav",
                json={
                    "source": "browser_nav",
                    "payload": {
                        "url": "https://shop.example.com/keyboard",
                        "title": "Mechanical keyboard deals",
                    },
                },
            ).json()
            second = client.post(
                f"/observations/{second_request['observation_id']}/excerpt",
                json={"title": "Keyboard", "text": "Unrelated shopping details."},
            ).json()
            recovered_status = client.get("/health").json()["provider_calls"]["tier2"]
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(first["action"], "notify")
        self.assertTrue(first["message"])
        self.assertEqual(failed_status["last_result"], "error")
        self.assertEqual(failed_status["reason"], "invalid_response")
        self.assertEqual(second["action"], "notify")
        self.assertEqual(second["message"], "정상 Writer 메시지입니다.")
        self.assertEqual(recovered_status["last_result"], "success")
        self.assertIsNone(recovered_status["reason"])

    def test_tier2_provider_receives_persona_prompt_and_escalation_context(self) -> None:
        provider = FakeTier2Provider(Tier2Result(confirm_drift=True, message="목표와 다른 페이지입니다."))
        client, store = self._client(provider)
        try:
            session_id = client.post("/sessions").json()["id"]
            client.post("/sessions/current/goal", json={"raw_text": "Kibitzer observation API"})
            store.record_observation(
                Observation(
                    id=f"obs_{uuid.uuid4().hex}",
                    ts=datetime.now(timezone.utc),
                    session_id=session_id,
                    source=Source.BROWSER_NAV,
                    payload={"url_host": "docs.example.com", "title": "API docs"},
                    features=ObservationFeatures(emb=[0.5], r0=0.9, tier_reached=0),
                    verdict=Verdict.OK,
                )
            )
            previous = store.record_observation(
                Observation(
                    id=f"obs_{uuid.uuid4().hex}",
                    ts=datetime.now(timezone.utc),
                    session_id=session_id,
                    source=Source.BROWSER_NAV,
                    payload={"url_host": "example.com", "title": "Old bread page"},
                    features=ObservationFeatures(emb=[0.1], r0=0.0, tier_reached=0),
                    verdict=Verdict.DRIFT,
                )
            )
            intervention_id = store.create_intervention(session_id, previous.id, "Old drift.")
            store.update_intervention_status(intervention_id, "delivered")

            request = client.post(
                "/observations/browser-nav",
                json={
                    "source": "browser_nav",
                    "payload": {
                        "url": "https://example.com/bread",
                        "title": "Sourdough bread recipe",
                    },
                },
            ).json()
            response = client.post(
                f"/observations/{request['observation_id']}/excerpt",
                json={"title": "Bread", "text": "Unrelated bread recipe."},
            )
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(response.json()["action"], "notify")
        self.assertEqual(len(provider.payloads), 1)
        self.assertIn("Return strict JSON only", provider.system_prompts[0])
        self.assertNotIn("Persona style layer", provider.system_prompts[0])
        self.assertNotIn("nagging_context", provider.payloads[0])
        self.assertEqual(len(provider.writer_payloads), 1)
        self.assertIn("Persona style layer", provider.writer_system_prompts[0])
        self.assertNotIn("page_excerpt", json.dumps(provider.writer_payloads[0]))
        context = provider.writer_payloads[0]["nagging_context"]
        self.assertEqual(context["nag_count_today"], 1)
        self.assertTrue(context["last_nag_ignored"])
        self.assertTrue(context["repeat_host"])
        self.assertIsNotNone(context["drift_minutes"])

    def test_quiet_hours_marks_notify_silent_and_records_suppression(self) -> None:
        provider = FakeTier2Provider(Tier2Result(confirm_drift=True, message="조용히 기록만 합니다."))
        delivery = DeliveryConfig(
            quiet_hours=QuietHoursConfig(enabled=True, start="00:00", end="00:00"),
        )
        client, _store = self._client(provider, delivery=delivery)
        try:
            request = self._start_goal_and_request_excerpt(client)
            response = client.post(
                f"/observations/{request['observation_id']}/excerpt",
                json={"title": "Bread", "text": "A recipe with unrelated steps."},
            )
        finally:
            client.__exit__(None, None, None)

        result = response.json()
        self.assertTrue(result["silent"])
        with closing(sqlite3.connect(self.db_path)) as conn:
            suppressed = conn.execute(
                "SELECT COUNT(*) FROM event_log WHERE event_type = 'delivery.suppressed_quiet_hours'"
            ).fetchone()[0]
            voice = conn.execute(
                "SELECT COUNT(*) FROM event_log WHERE event_type = 'delivery.voice_spoken'"
            ).fetchone()[0]
        self.assertEqual(suppressed, 1)
        self.assertEqual(voice, 0)

    def test_voice_is_disabled_by_default_and_invoked_when_enabled(self) -> None:
        provider = FakeTier2Provider(Tier2Result(confirm_drift=True, message="목표와 다른 페이지입니다."))
        client, _store = self._client(provider)
        try:
            request = self._start_goal_and_request_excerpt(client)
            with patch("apps.server.app.api.observations.speak") as speak_mock:
                client.post(
                    f"/observations/{request['observation_id']}/excerpt",
                    json={"title": "Bread", "text": "A recipe with unrelated steps."},
                )
                speak_mock.assert_not_called()
        finally:
            client.__exit__(None, None, None)

        self.db_path.unlink()
        provider = FakeTier2Provider(Tier2Result(confirm_drift=True, message="목표와 다른 페이지입니다."))
        delivery = DeliveryConfig(voice=VoiceConfig(enabled=True, voice="Alex", rate=150))
        client, _store = self._client(provider, delivery=delivery)
        try:
            request = self._start_goal_and_request_excerpt(client)
            with patch("apps.server.app.api.observations.speak") as speak_mock:
                client.post(
                    f"/observations/{request['observation_id']}/excerpt",
                    json={"title": "Bread", "text": "A recipe with unrelated steps."},
                )
                speak_mock.assert_called_once()
        finally:
            client.__exit__(None, None, None)


if __name__ == "__main__":
    unittest.main()
