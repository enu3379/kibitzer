import asyncio
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from apps.server.tests.support import TestClient

from apps.server.app.config import AppConfig, ControllerConfig, ServerConfig, Tier1Config, Tier2Config, TimeBudgetConfig
from apps.server.app.core.controller_flow import controller_state_after_intervention
from apps.server.app.core.time_budget import (
    TIER2_REVIEW_LEAD_SECONDS,
    next_review_boundary,
    review_is_due,
    seconds_until_review_due,
    thresholds_for_budget,
)
from apps.server.app.main import create_app
from apps.server.app.providers.judges.base import Tier1Result, Tier2Decision, Tier2Result
from apps.server.app.schemas import Verdict
from apps.server.app.storage.sqlite import DriftClockStateRecord, SQLiteStore


class FakeTier2Provider:
    def __init__(self, result: Tier2Result) -> None:
        self.result = result
        self.payloads: list[dict[str, object]] = []
        self.writer_payloads: list[dict[str, object]] = []

    async def classify_tier1(self, payload: dict[str, object]) -> Tier1Result:
        return Tier1Result(verdict=Verdict.DRIFT, reason="unused")

    async def confirm_tier2(
        self,
        payload: dict[str, object],
        system_prompt: str | None = None,
    ) -> Tier2Result:
        self.payloads.append(payload)
        return self.result

    async def decide_tier2(
        self,
        payload: dict[str, object],
        system_prompt: str | None = None,
    ) -> Tier2Decision:
        self.payloads.append(payload)
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
        return self.result.message or ""


class BlockingTier2Provider(FakeTier2Provider):
    def __init__(self, result: Tier2Result) -> None:
        super().__init__(result)
        self.gate = threading.Event()

    async def decide_tier2(
        self,
        payload: dict[str, object],
        system_prompt: str | None = None,
    ) -> Tier2Decision:
        await asyncio.to_thread(self.gate.wait)
        return await super().decide_tier2(payload, system_prompt)


def clock_state(**changes: object) -> DriftClockStateRecord:
    now = datetime(2026, 7, 14, tzinfo=timezone.utc)
    values: dict[str, object] = {
        "session_id": "session",
        "active_observation_id": "obs",
        "active_tab_id": 1,
        "active_url_host": "example.com",
        "active_url_path_hash": "hash",
        "active_verdict": "DRIFT",
        "active_since_at": now,
        "last_heartbeat_at": now,
        "current_page_drift_seconds": 0,
        "continuous_drift_seconds": 0,
        "cumulative_drift_seconds": 0,
        "next_review_mode_seconds": 0,
        "review_observation_id": None,
        "review_started_at": None,
        "review_status": "none",
        "last_defer_reason": None,
        "updated_at": now,
    }
    values.update(changes)
    return DriftClockStateRecord(**values)  # type: ignore[arg-type]


class TimeBudgetPolicyTest(unittest.TestCase):
    def test_thresholds_use_budget_floor_and_fallback(self) -> None:
        config = TimeBudgetConfig(enabled=True)
        self.assertEqual(thresholds_for_budget(config, None).total_seconds, 900)
        self.assertEqual(thresholds_for_budget(config, 10).total_seconds, 300)
        self.assertEqual(thresholds_for_budget(config, 120).total_seconds, 1200)

    def test_per_page_valve_and_defer_boundary(self) -> None:
        config = TimeBudgetConfig(enabled=True, fallback_total_seconds=1200, per_page_seconds=180)
        thresholds = thresholds_for_budget(config, None)
        state = clock_state(current_page_drift_seconds=600, continuous_drift_seconds=600)
        self.assertTrue(review_is_due(state, "streak", thresholds, event_eligible=True))
        deferred = clock_state(
            current_page_drift_seconds=600,
            continuous_drift_seconds=600,
            next_review_mode_seconds=next_review_boundary(600, thresholds.total_seconds),
        )
        self.assertFalse(review_is_due(deferred, "streak", thresholds, event_eligible=True))
        self.assertEqual(deferred.next_review_mode_seconds, 1200)

    def test_remaining_time_combines_all_review_gates(self) -> None:
        thresholds = thresholds_for_budget(
            TimeBudgetConfig(enabled=True, fallback_total_seconds=180, per_page_seconds=60),
            None,
        )
        state = clock_state(current_page_drift_seconds=60, continuous_drift_seconds=60)
        self.assertEqual(
            seconds_until_review_due(state, "streak", thresholds, event_eligible=True),
            TIER2_REVIEW_LEAD_SECONDS,
        )
        due = clock_state(current_page_drift_seconds=90, continuous_drift_seconds=90)
        self.assertEqual(seconds_until_review_due(due, "streak", thresholds, True), 0)


class D7ApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "kibitzer.sqlite3"
        self.store = SQLiteStore(self.db_path)
        self.provider = FakeTier2Provider(Tier2Result(confirm_drift=True, message="시간 예산과 무관한 페이지입니다."))
        self.config = AppConfig(
            server=ServerConfig(db_path=str(self.db_path)),
            tier1=Tier1Config(enabled=False),
            tier2=Tier2Config(enabled=True, excerpt_char_limit=120),
            controller=ControllerConfig(k=1, coldstart_observations=1, cooldown_seconds=0),
            time_budget=TimeBudgetConfig(
                enabled=True,
                fallback_total_seconds=180,
                min_total_seconds=60,
                per_page_seconds=60,
                heartbeat_seconds=60,
                max_heartbeat_gap_seconds=90,
                recent_excerpts=2,
                recent_excerpt_char_limit=40,
            ),
        )
        self.client = TestClient(create_app(config=self.config, store=self.store, tier2_provider=self.provider))
        self.client.__enter__()
        self.start = datetime(2026, 7, 14, 8, 0, tzinfo=timezone.utc)

    def tearDown(self) -> None:
        self.client.__exit__(None, None, None)
        self.tmpdir.cleanup()

    def _start_session_goal(self) -> None:
        self.client.post("/sessions")
        goal = self.client.post(
            "/sessions/current/goal",
            json={"raw_text": "Kibitzer observation API", "available_time_minutes": 18},
        )
        self.assertEqual(goal.status_code, 200)
        self.assertEqual(goal.json()["available_time_minutes"], 18)

    def _post_observation(
        self,
        url: str,
        title: str,
        at: datetime | None = None,
        tab_id: int = 7,
    ) -> tuple[str, str]:
        response = self.client.post(
            "/observations/browser-nav",
            json={
                "source": "browser_nav",
                "ts": (at or self.start).isoformat(),
                "payload": {
                    "url": url,
                    "title": title,
                    "tab_id": tab_id,
                },
            },
        ).json()
        self.assertEqual(response["action"], "none")
        observation_id = str(response["observation_id"])
        path_hash = self.store.get_observation(observation_id).url_path_hash
        assert path_hash
        return observation_id, path_hash

    def _start_drift_observation(self) -> tuple[str, str]:
        self._start_session_goal()
        return self._post_observation(
            "https://example.com/bread",
            "Sourdough bread recipe",
        )

    def _presence(
        self,
        observation_id: str,
        path_hash: str,
        event_id: str,
        kind: str,
        at: datetime,
    ) -> dict[str, object]:
        with patch("apps.server.app.api.observations.datetime") as mocked_datetime:
            mocked_datetime.now.return_value = at
            response = self.client.post(
                f"/observations/{observation_id}/presence",
                json={
                    "event_id": event_id,
                    "kind": kind,
                    "tab_id": 7,
                    "url_path_hash": path_hash,
                },
            )
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_review_precomputes_at_lead_time_with_threshold_projected_context(self) -> None:
        self._start_session_goal()
        self._post_observation(
            "https://example.com/kibitzer",
            "Kibitzer observation API",
            self.start - timedelta(seconds=31),
        )
        observation_id, path_hash = self._post_observation(
            "https://example.com/bread",
            "Sourdough bread recipe",
            self.start,
        )
        content = self.client.post(
            f"/observations/{observation_id}/content",
            json={"title": "Bread", "text": "A long recipe unrelated to Kibitzer."},
        )
        self.assertEqual(content.status_code, 200)
        self.assertTrue(content.json()["stored"])

        first = self._presence(observation_id, path_hash, "active", "active", self.start)
        second = self._presence(observation_id, path_hash, "one-minute", "heartbeat", self.start + timedelta(seconds=60))
        third = self._presence(
            observation_id,
            path_hash,
            "threshold",
            "heartbeat",
            self.start + timedelta(seconds=90),
        )

        self.assertEqual(first["action"], "none")
        self.assertEqual(first["next_review_check_seconds"], 60)
        self.assertEqual(second["action"], "none")
        self.assertEqual(second["next_review_check_seconds"], 30)
        self.assertEqual(third["action"], "notify")
        self.assertEqual(third["next_review_check_seconds"], 60)
        self.assertEqual(len(self.provider.payloads), 1)
        self.assertEqual(self.provider.payloads[0]["review_kind"], "combined")
        self.assertEqual(self.provider.payloads[0]["time_budget"]["current_page_drift_seconds"], 90)
        self.assertEqual(self.provider.payloads[0]["time_budget"]["mode_clock_seconds"], 90)
        self.assertEqual(len(self.provider.writer_payloads), 1)
        self.assertEqual(self.provider.writer_payloads[0]["nagging_context"]["drift_minutes"], 2)
        state = self.store.get_drift_clock_state(self.client.get("/sessions/current/state").json()["session_id"])
        self.assertEqual(state.current_page_drift_seconds, 90)

    def test_precomputed_review_is_discarded_when_page_leaves_before_threshold(self) -> None:
        observation_id, path_hash = self._start_drift_observation()
        self._presence(observation_id, path_hash, "leave-active", "active", self.start)
        session_id = self.client.get("/sessions/current/state").json()["session_id"]

        prepared = self._presence(
            observation_id,
            path_hash,
            "leave-prefetch",
            "heartbeat",
            self.start + timedelta(seconds=60),
        )
        result = self._presence(
            observation_id,
            path_hash,
            "leave-before-threshold",
            "inactive",
            self.start + timedelta(seconds=89),
        )

        self.assertEqual(prepared["next_review_check_seconds"], 30)
        self.assertEqual(result["action"], "none")
        self.assertIsNone(self.store.get_prepared_d7_review(session_id, observation_id))
        with self.store._connect() as conn:
            intervention_count = conn.execute(
                "SELECT COUNT(*) FROM interventions WHERE session_id = ?",
                (session_id,),
            ).fetchone()[0]
        self.assertEqual(intervention_count, 0)
        state = self.store.get_drift_clock_state(session_id)
        self.assertIsNone(state.active_observation_id)
        self.assertEqual(state.review_status, "retry")

    def test_precomputed_review_survives_server_restart_without_second_llm_call(self) -> None:
        observation_id, path_hash = self._start_drift_observation()
        self._presence(observation_id, path_hash, "restart-active", "active", self.start)
        prepared = self._presence(
            observation_id,
            path_hash,
            "restart-prefetch",
            "heartbeat",
            self.start + timedelta(seconds=60),
        )
        self.assertEqual(prepared["next_review_check_seconds"], 30)
        self.assertEqual(len(self.provider.payloads), 1)

        self.client.__exit__(None, None, None)
        self.client = TestClient(
            create_app(config=self.config, store=self.store, tier2_provider=self.provider),
        )
        self.client.__enter__()

        result = self._presence(
            observation_id,
            path_hash,
            "restart-threshold",
            "heartbeat",
            self.start + timedelta(seconds=90),
        )
        self.assertEqual(result["action"], "notify")
        self.assertEqual(len(self.provider.payloads), 1)
        self.assertIsNone(self.store.get_prepared_d7_review(
            self.client.get("/sessions/current/state").json()["session_id"],
            observation_id,
        ))

    def test_slow_precompute_returns_immediately_and_threshold_poll_retries(self) -> None:
        blocking = BlockingTier2Provider(
            Tier2Result(confirm_drift=True, message="시간 예산과 무관한 페이지입니다."),
        )
        self.provider = blocking
        self.client.app.state.runtime._provided_tier2_provider = blocking
        self.client.app.state.runtime._tier2_provider = blocking
        observation_id, path_hash = self._start_drift_observation()
        self._presence(observation_id, path_hash, "slow-active", "active", self.start)

        started = time.monotonic()
        queued = self._presence(
            observation_id,
            path_hash,
            "slow-prefetch",
            "heartbeat",
            self.start + timedelta(seconds=60),
        )
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertEqual(queued["next_review_check_seconds"], 30)

        waiting = self._presence(
            observation_id,
            path_hash,
            "slow-threshold",
            "heartbeat",
            self.start + timedelta(seconds=90),
        )
        self.assertEqual(waiting["action"], "none")
        self.assertEqual(waiting["next_review_check_seconds"], 1)

        blocking.gate.set()
        session_id = self.client.get("/sessions/current/state").json()["session_id"]
        prepared = None
        for _ in range(100):
            prepared = self.store.get_prepared_d7_review(session_id, observation_id)
            if prepared and prepared.outcome is not None:
                break
            time.sleep(0.01)
        self.assertIsNotNone(prepared)
        self.assertIsNotNone(prepared.outcome)

        result = self._presence(
            observation_id,
            path_hash,
            "slow-ready",
            "heartbeat",
            self.start + timedelta(seconds=91),
        )
        self.assertEqual(result["action"], "notify")

    def test_related_page_label_immediately_discards_precomputed_review(self) -> None:
        observation_id, path_hash = self._start_drift_observation()
        self._presence(observation_id, path_hash, "label-active", "active", self.start)
        prepared = self._presence(
            observation_id,
            path_hash,
            "label-prefetch",
            "heartbeat",
            self.start + timedelta(seconds=60),
        )
        self.assertEqual(prepared["next_review_check_seconds"], 30)

        response = self.client.post(
            f"/observations/{observation_id}/label",
            json={"label": "related"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["verdict"], "OK")
        session_id = self.client.get("/sessions/current/state").json()["session_id"]
        self.assertIsNone(self.store.get_prepared_d7_review(session_id, observation_id))
        self.assertEqual(self.store.get_drift_clock_state(session_id).review_status, "retry")

    def test_duplicate_presence_does_not_double_count(self) -> None:
        observation_id, path_hash = self._start_drift_observation()
        self._presence(observation_id, path_hash, "active", "active", self.start)
        self._presence(observation_id, path_hash, "same", "heartbeat", self.start + timedelta(seconds=60))
        self._presence(observation_id, path_hash, "same", "heartbeat", self.start + timedelta(seconds=90))
        session_id = self.client.get("/sessions/current/state").json()["session_id"]
        state = self.store.get_drift_clock_state(session_id)
        self.assertEqual(state.current_page_drift_seconds, 60)

    def test_time_review_ignores_streak_gate_after_coldstart(self) -> None:
        self.config.controller.k = 3
        self.config.controller.coldstart_observations = 5
        self._start_session_goal()
        for index in range(4):
            self._post_observation(
                f"https://example.com/kibitzer-{index}",
                "Kibitzer observation API",
                self.start + timedelta(seconds=index),
            )
        observation_id, path_hash = self._post_observation(
            "https://example.com/bread",
            "Sourdough bread recipe",
            self.start + timedelta(seconds=5),
        )
        self._presence(observation_id, path_hash, "active-k3", "active", self.start + timedelta(seconds=5))
        prepared = self._presence(
            observation_id,
            path_hash,
            "minute-k3",
            "heartbeat",
            self.start + timedelta(seconds=65),
        )
        self.assertEqual(prepared["next_review_check_seconds"], 30)
        result = self._presence(
            observation_id,
            path_hash,
            "threshold-k3",
            "heartbeat",
            self.start + timedelta(seconds=95),
        )
        self.assertEqual(result["action"], "notify")

    def test_active_presence_reclaims_clock_from_another_page(self) -> None:
        observation_id, path_hash = self._start_drift_observation()
        self._presence(observation_id, path_hash, "first-active", "active", self.start)
        other_id, other_hash = self._post_observation(
            "https://example.com/games",
            "Unrelated games",
            self.start + timedelta(seconds=10),
        )
        self._presence(other_id, other_hash, "other-active", "active", self.start + timedelta(seconds=10))
        self._presence(observation_id, path_hash, "reclaimed", "active", self.start + timedelta(seconds=20))
        self._presence(observation_id, path_hash, "reclaimed-heartbeat", "heartbeat", self.start + timedelta(seconds=80))
        session_id = self.client.get("/sessions/current/state").json()["session_id"]
        state = self.store.get_drift_clock_state(session_id)
        self.assertEqual(state.active_observation_id, observation_id)
        self.assertEqual(state.current_page_drift_seconds, 60)

    def test_reasserting_active_does_not_credit_an_unverified_gap(self) -> None:
        observation_id, path_hash = self._start_drift_observation()
        self._presence(observation_id, path_hash, "gap-active", "active", self.start)
        self._presence(
            observation_id,
            path_hash,
            "gap-refocus",
            "active",
            self.start + timedelta(seconds=120),
        )
        session_id = self.client.get("/sessions/current/state").json()["session_id"]
        self.assertEqual(self.store.get_drift_clock_state(session_id).current_page_drift_seconds, 0)
        self._presence(
            observation_id,
            path_hash,
            "gap-heartbeat",
            "heartbeat",
            self.start + timedelta(seconds=180),
        )
        self.assertEqual(self.store.get_drift_clock_state(session_id).current_page_drift_seconds, 60)

    def test_same_page_return_preserves_per_page_dwell(self) -> None:
        observation_id, path_hash = self._start_drift_observation()
        self._presence(observation_id, path_hash, "page-active", "active", self.start)
        self._presence(observation_id, path_hash, "page-forty", "heartbeat", self.start + timedelta(seconds=40))
        self._presence(observation_id, path_hash, "page-away", "inactive", self.start + timedelta(seconds=50))
        other_id, other_hash = self._post_observation(
            "https://example.com/games",
            "Unrelated games",
            self.start + timedelta(seconds=55),
        )
        self._presence(other_id, other_hash, "page-other", "active", self.start + timedelta(seconds=60))
        self._presence(other_id, other_hash, "page-other-away", "inactive", self.start + timedelta(seconds=65))
        returned_id, returned_hash = self._post_observation(
            "https://example.com/bread",
            "Sourdough bread recipe",
            self.start + timedelta(seconds=70),
        )
        returned = self._presence(
            returned_id,
            returned_hash,
            "page-return",
            "active",
            self.start + timedelta(seconds=75),
        )
        session_id = self.client.get("/sessions/current/state").json()["session_id"]
        self.assertEqual(self.store.get_drift_clock_state(session_id).current_page_drift_seconds, 50)
        self.assertEqual(returned["next_review_check_seconds"], 10)
        prepared = self._presence(
            returned_id,
            returned_hash,
            "page-return-prefetch",
            "heartbeat",
            self.start + timedelta(seconds=85),
        )
        self.assertEqual(prepared["next_review_check_seconds"], 30)
        result = self._presence(
            returned_id,
            returned_hash,
            "page-return-threshold",
            "heartbeat",
            self.start + timedelta(seconds=115),
        )
        self.assertEqual(result["action"], "notify")

    def test_same_path_on_different_host_resets_per_page_dwell(self) -> None:
        self._start_session_goal()
        observation_id, path_hash = self._post_observation(
            "https://example.com/",
            "Sourdough bread recipe",
        )
        self._presence(observation_id, path_hash, "host-active", "active", self.start)
        self._presence(observation_id, path_hash, "host-minute", "heartbeat", self.start + timedelta(seconds=60))
        self._presence(observation_id, path_hash, "host-away", "inactive", self.start + timedelta(seconds=70))
        other_id, other_hash = self._post_observation(
            "https://different.example/",
            "Unrelated games",
            self.start + timedelta(seconds=75),
        )
        self.assertEqual(other_hash, path_hash)
        self._presence(other_id, other_hash, "other-host-active", "active", self.start + timedelta(seconds=80))
        session_id = self.client.get("/sessions/current/state").json()["session_id"]
        self.assertEqual(self.store.get_drift_clock_state(session_id).current_page_drift_seconds, 0)

    def test_missing_excerpt_runs_one_title_capable_review(self) -> None:
        observation_id, path_hash = self._start_drift_observation()
        self._presence(observation_id, path_hash, "no-content-active", "active", self.start)
        prepared = self._presence(
            observation_id,
            path_hash,
            "no-content-minute",
            "heartbeat",
            self.start + timedelta(seconds=60),
        )
        self.assertEqual(prepared["next_review_check_seconds"], 30)
        result = self._presence(
            observation_id,
            path_hash,
            "no-content-threshold",
            "heartbeat",
            self.start + timedelta(seconds=90),
        )
        self.assertEqual(result["action"], "notify")
        self.assertEqual([payload["review_kind"] for payload in self.provider.payloads], ["combined"])
        self.assertIsNone(self.provider.payloads[0]["current"]["page_excerpt"])

    def test_missing_judge_defers_and_consumes_window(self) -> None:
        observation_id, path_hash = self._start_drift_observation()
        self.client.app.state.runtime._tier2_provider = None
        self._presence(observation_id, path_hash, "fallback-active", "active", self.start)
        prepared = self._presence(
            observation_id,
            path_hash,
            "fallback-minute",
            "heartbeat",
            self.start + timedelta(seconds=60),
        )
        self.assertEqual(prepared["next_review_check_seconds"], 30)
        result = self._presence(
            observation_id,
            path_hash,
            "fallback-threshold",
            "heartbeat",
            self.start + timedelta(seconds=90),
        )
        self.assertEqual(result["action"], "none")
        session_id = self.client.get("/sessions/current/state").json()["session_id"]
        state = self.store.get_drift_clock_state(session_id)
        self.assertEqual(state.next_review_mode_seconds, 180)
        self.assertEqual(state.review_status, "deferred")
        self.assertEqual(state.last_defer_reason, "provider_error")

    def test_notification_consumes_review_window(self) -> None:
        observation_id, path_hash = self._start_drift_observation()
        self._presence(observation_id, path_hash, "window-active", "active", self.start)
        prepared = self._presence(
            observation_id,
            path_hash,
            "window-minute",
            "heartbeat",
            self.start + timedelta(seconds=60),
        )
        self.assertEqual(prepared["next_review_check_seconds"], 30)
        result = self._presence(
            observation_id,
            path_hash,
            "window-threshold",
            "heartbeat",
            self.start + timedelta(seconds=90),
        )
        self.assertEqual(result["action"], "notify")
        session_id = self.client.get("/sessions/current/state").json()["session_id"]
        self.assertEqual(self.store.get_drift_clock_state(session_id).next_review_mode_seconds, 180)
        first_check = self._presence(
            observation_id,
            path_hash,
            "window-next-check",
            "heartbeat",
            self.start + timedelta(seconds=150),
        )
        self.assertEqual(first_check["action"], "none")
        self.assertEqual(first_check["next_review_check_seconds"], 30)
        renag = self._presence(
            observation_id,
            path_hash,
            "window-renag",
            "heartbeat",
            self.start + timedelta(seconds=180),
        )
        self.assertEqual(renag["action"], "notify")
        with self.store._connect() as conn:
            count = conn.execute(
                "SELECT COUNT(*) FROM interventions WHERE session_id = ?",
                (session_id,),
            ).fetchone()[0]
        self.assertEqual(count, 2)

    def test_concurrent_prepared_delivery_commits_one_notification(self) -> None:
        observation_id, path_hash = self._start_drift_observation()
        self._presence(observation_id, path_hash, "atomic-active", "active", self.start)
        self._presence(
            observation_id,
            path_hash,
            "atomic-prefetch",
            "heartbeat",
            self.start + timedelta(seconds=60),
        )
        session_id = self.client.get("/sessions/current/state").json()["session_id"]
        notified_at = self.start + timedelta(seconds=90)
        controller_state = controller_state_after_intervention(
            self.store,
            self.config.controller,
            session_id,
            now=notified_at,
        )
        barrier = threading.Barrier(2)

        def commit() -> str | None:
            barrier.wait()
            return self.store.commit_d7_review_notification(
                session_id,
                observation_id,
                "한 번만 전달됩니다.",
                controller_state,
                180,
                ts=notified_at,
            )

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _index: commit(), range(2)))

        self.assertEqual(len([result for result in results if result is not None]), 1)
        with self.store._connect() as conn:
            intervention_count = conn.execute(
                "SELECT COUNT(*) FROM interventions WHERE session_id = ?",
                (session_id,),
            ).fetchone()[0]
            event_counts = {
                row["event_type"]: row["count"]
                for row in conn.execute(
                    """
                    SELECT event_type, COUNT(*) AS count
                    FROM event_log
                    WHERE session_id = ?
                      AND event_type IN ('tier2.confirmed', 'd7.review_notified')
                    GROUP BY event_type
                    """,
                    (session_id,),
                ).fetchall()
            }
        self.assertEqual(intervention_count, 1)
        self.assertEqual(event_counts, {"d7.review_notified": 1, "tier2.confirmed": 1})

    def test_deferred_review_uses_presence_timestamp(self) -> None:
        observation_id, path_hash = self._start_drift_observation()
        self.provider.result = Tier2Result(confirm_drift=False, message=None)
        self._presence(observation_id, path_hash, "defer-active", "active", self.start)
        prepared = self._presence(
            observation_id,
            path_hash,
            "defer-minute",
            "heartbeat",
            self.start + timedelta(seconds=60),
        )
        self.assertEqual(prepared["next_review_check_seconds"], 30)
        reviewed_at = self.start + timedelta(seconds=90)
        result = self._presence(
            observation_id,
            path_hash,
            "defer-threshold",
            "heartbeat",
            reviewed_at,
        )
        self.assertEqual(result["action"], "none")
        with self.store._connect() as conn:
            rows = conn.execute(
                """
                SELECT ts, event_type
                FROM event_log
                WHERE event_type IN ('tier2.cancelled', 'd7.review_deferred')
                ORDER BY id
                """
            ).fetchall()
        self.assertEqual([row["event_type"] for row in rows], ["tier2.cancelled", "d7.review_deferred"])
        self.assertEqual({row["ts"] for row in rows}, {reviewed_at.isoformat()})

    def test_review_transition_events_require_matching_lock(self) -> None:
        observation_id, _path_hash = self._start_drift_observation()
        session_id = self.client.get("/sessions/current/state").json()["session_id"]
        stale_id = f"stale-{observation_id}"
        self.store.defer_d7_review(
            session_id,
            stale_id,
            next_review_mode_seconds=180,
            reason="stale_review",
            ts=self.start,
        )
        self.store.complete_d7_review_notification(
            session_id,
            stale_id,
            next_review_mode_seconds=180,
            ts=self.start,
        )
        with self.store._connect() as conn:
            count = conn.execute(
                """
                SELECT COUNT(*)
                FROM event_log
                WHERE event_type IN ('d7.review_deferred', 'd7.review_notified')
                """
            ).fetchone()[0]
        self.assertEqual(count, 0)

    def test_stale_review_lock_expires_on_presence(self) -> None:
        observation_id, path_hash = self._start_drift_observation()
        self._presence(observation_id, path_hash, "stale-active", "active", self.start)
        session_id = self.client.get("/sessions/current/state").json()["session_id"]
        with self.store._connect() as conn:
            conn.execute(
                """
                UPDATE drift_clock_states
                SET review_observation_id = ?, review_started_at = NULL,
                    review_status = 'reviewing', updated_at = ?
                WHERE session_id = ?
                """,
                (observation_id, (self.start - timedelta(minutes=5)).isoformat(), session_id),
            )
        prepared = self._presence(
            observation_id,
            path_hash,
            "stale-minute",
            "heartbeat",
            self.start + timedelta(seconds=60),
        )
        self.assertEqual(prepared["next_review_check_seconds"], 30)
        result = self._presence(
            observation_id,
            path_hash,
            "stale-threshold",
            "heartbeat",
            self.start + timedelta(seconds=90),
        )
        self.assertEqual(result["action"], "notify")

    def test_ok_activation_resets_deferred_boundary(self) -> None:
        observation_id, path_hash = self._start_drift_observation()
        self._presence(observation_id, path_hash, "reset-active", "active", self.start)
        session_id = self.client.get("/sessions/current/state").json()["session_id"]
        with self.store._connect() as conn:
            conn.execute(
                """
                UPDATE drift_clock_states
                SET next_review_mode_seconds = 360, last_defer_reason = 'acceptable_side_branch'
                WHERE session_id = ?
                """,
                (session_id,),
            )
        ok_id, ok_hash = self._post_observation(
            "https://example.com/kibitzer",
            "Kibitzer observation API",
            self.start + timedelta(seconds=10),
        )
        self._presence(ok_id, ok_hash, "ok-active", "active", self.start + timedelta(seconds=10))
        state = self.store.get_drift_clock_state(session_id)
        self.assertEqual(state.continuous_drift_seconds, 0)
        self.assertEqual(state.next_review_mode_seconds, 0)
        self.assertIsNone(state.last_defer_reason)

    def test_alignment_ok_keeps_cumulative_review_boundary(self) -> None:
        self.config.controller.type = "alignment"
        observation_id, path_hash = self._start_drift_observation()
        self._presence(observation_id, path_hash, "alignment-active", "active", self.start)
        session_id = self.client.get("/sessions/current/state").json()["session_id"]
        with self.store._connect() as conn:
            conn.execute(
                """
                UPDATE drift_clock_states
                SET next_review_mode_seconds = 360, last_defer_reason = 'acceptable_side_branch'
                WHERE session_id = ?
                """,
                (session_id,),
            )
        ok_id, ok_hash = self._post_observation(
            "https://example.com/kibitzer-alignment",
            "Kibitzer observation API",
            self.start + timedelta(seconds=10),
        )
        self._presence(ok_id, ok_hash, "alignment-ok", "active", self.start + timedelta(seconds=10))
        state = self.store.get_drift_clock_state(session_id)
        self.assertEqual(state.next_review_mode_seconds, 360)
        self.assertEqual(state.last_defer_reason, "acceptable_side_branch")

    def test_identical_goal_preserves_controller_and_clock(self) -> None:
        observation_id, path_hash = self._start_drift_observation()
        self._presence(observation_id, path_hash, "goal-active", "active", self.start)
        self._presence(observation_id, path_hash, "goal-minute", "heartbeat", self.start + timedelta(seconds=60))
        session_id = self.client.get("/sessions/current/state").json()["session_id"]
        snoozed_until = self.start + timedelta(minutes=30)
        self.store.save_controller_state(
            session_id,
            streak=2,
            obs_count=4,
            last_intervention_ts=None,
            snoozed_until=snoozed_until,
            ts=self.start,
        )
        response = self.client.post(
            "/sessions/current/goal",
            json={"raw_text": "Kibitzer observation API", "available_time_minutes": 18},
        )
        self.assertEqual(response.status_code, 200)
        controller = self.store.get_controller_state(session_id)
        clock = self.store.get_drift_clock_state(session_id)
        self.assertEqual(controller.obs_count, 4)
        self.assertEqual(controller.snoozed_until, snoozed_until)
        self.assertEqual(clock.current_page_drift_seconds, 60)

    def test_implicit_session_end_prunes_d7_ephemeral_rows(self) -> None:
        observation_id, path_hash = self._start_drift_observation()
        self.client.post(
            f"/observations/{observation_id}/content",
            json={"title": "Bread", "text": "A bounded excerpt."},
        )
        self._presence(observation_id, path_hash, "prune-active", "active", self.start)
        self._presence(observation_id, path_hash, "prune-heartbeat", "heartbeat", self.start + timedelta(seconds=60))
        old_session_id = self.client.get("/sessions/current/state").json()["session_id"]
        self.client.post("/sessions")
        with self.store._connect() as conn:
            excerpt_count = conn.execute(
                "SELECT COUNT(*) FROM observation_excerpts WHERE session_id = ?",
                (old_session_id,),
            ).fetchone()[0]
            presence_count = conn.execute(
                "SELECT COUNT(*) FROM dwell_presence_events WHERE session_id = ?",
                (old_session_id,),
            ).fetchone()[0]
            page_dwell_count = conn.execute(
                "SELECT COUNT(*) FROM drift_page_dwell_states WHERE session_id = ?",
                (old_session_id,),
            ).fetchone()[0]
            prepared_count = conn.execute(
                "SELECT COUNT(*) FROM d7_prepared_reviews WHERE session_id = ?",
                (old_session_id,),
            ).fetchone()[0]
        self.assertEqual(
            (excerpt_count, presence_count, page_dwell_count, prepared_count),
            (0, 0, 0, 0),
        )


if __name__ == "__main__":
    unittest.main()
