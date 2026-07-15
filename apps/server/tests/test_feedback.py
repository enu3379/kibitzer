import sqlite3
import tempfile
import unittest
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from apps.server.tests.support import AlwaysNotifyTier2Provider, TestClient

from apps.server.app.config import (
    AppConfig,
    BreakConfig,
    ControllerConfig,
    RelevanceConfig,
    ServerConfig,
    Tier1Config,
    Tier2Config,
)
from apps.server.app.core.delivery import clamp_notification_message
from apps.server.app.main import create_app
from apps.server.app.storage.sqlite import SQLiteStore


class FeedbackApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "kibitzer.sqlite3"
        self.store = SQLiteStore(self.db_path)

    def tearDown(self) -> None:
        self.tmpdir.cleanup()

    def _client(
        self,
        exemplar_cap: int = 20,
        break_duration_seconds: int = 300,
        controller: ControllerConfig | None = None,
    ) -> TestClient:
        config = AppConfig(
            server=ServerConfig(db_path=str(self.db_path)),
            tier1=Tier1Config(enabled=False),
            tier2=Tier2Config(enabled=False),
            relevance=RelevanceConfig(exemplar_cap=exemplar_cap),
            controller=controller
            or ControllerConfig(k=1, coldstart_observations=1, cooldown_seconds=0, snooze_seconds=900),
            intentional_break=BreakConfig(duration_seconds=break_duration_seconds),
        )
        client = TestClient(
            create_app(
                config=config,
                store=self.store,
                tier2_provider=AlwaysNotifyTier2Provider(),
            )
        )
        client.__enter__()
        return client

    def _start_goal(self, client: TestClient) -> str:
        session_id = client.post("/sessions").json()["id"]
        client.post("/sessions/current/goal", json={"raw_text": "Kibitzer observation API"})
        return session_id

    def _notify(self, client: TestClient, title: str = "Sourdough bread recipe") -> dict[str, object]:
        request = client.post(
            "/observations/browser-nav",
            json={
                "source": "browser_nav",
                "payload": {
                    "url": f"https://example.com/{title.lower().replace(' ', '-')}",
                    "title": title,
                },
            },
        ).json()
        self.assertEqual(request["action"], "request_excerpt")
        response = client.post(
            f"/observations/{request['observation_id']}/excerpt",
            json={"title": title, "text": f"{title} unrelated content"},
        ).json()
        self.assertEqual(response["action"], "notify")
        return response

    def test_related_feedback_adds_exemplar_once_and_marks_intervention(self) -> None:
        client = self._client()
        try:
            session_id = self._start_goal(client)
            notification = self._notify(client)
            feedback = client.post(
                "/feedback",
                json={
                    "kind": "related",
                    "intervention_id": notification["intervention_id"],
                    "observation_id": notification["observation_id"],
                },
            ).json()
            duplicate = client.post(
                "/feedback",
                json={
                    "kind": "related",
                    "intervention_id": notification["intervention_id"],
                    "observation_id": notification["observation_id"],
                },
            ).json()
        finally:
            client.__exit__(None, None, None)

        self.assertFalse(feedback["duplicate"])
        self.assertEqual(feedback["intervention_status"], "related")
        self.assertEqual(feedback["verdict"], "OK")
        self.assertEqual(feedback["exemplar_count"], 2)
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(duplicate["verdict"], "OK")
        self.assertEqual(duplicate["exemplar_count"], 2)
        self.assertEqual(self.store.goal_exemplar_count(session_id), 2)
        observation_id = str(notification["observation_id"])
        self.assertEqual(self.store.page_label_for_observation(observation_id), "related")
        self.assertEqual(self.store.get_observation(observation_id).verdict, "DRIFT")
        with closing(sqlite3.connect(self.db_path)) as conn:
            feedback_count = conn.execute("SELECT COUNT(*) FROM feedback WHERE kind = 'related'").fetchone()[0]
        self.assertEqual(feedback_count, 1)

    def test_related_feedback_replays_historical_alignment_with_point_eighty_five(self) -> None:
        client = self._client(
            controller=ControllerConfig(
                type="alignment",
                alignment_alpha=0.5,
                theta_low=0.3,
                theta_high=0.6,
                coldstart_observations=1,
                cooldown_seconds=0,
            )
        )
        try:
            self._start_goal(client)
            notification = self._notify(client)
            later = client.post(
                "/observations/browser-nav",
                json={
                    "source": "browser_nav",
                    "payload": {
                        "url": "https://example.com/kibitzer-api",
                        "title": "Kibitzer observation API docs",
                    },
                },
            ).json()
            later_observation = self.store.get_observation(str(later["observation_id"]))
            feedback = client.post(
                "/feedback",
                json={
                    "kind": "related",
                    "intervention_id": notification["intervention_id"],
                    "observation_id": notification["observation_id"],
                },
            ).json()
            state = client.get("/sessions/current/state").json()
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(feedback["verdict"], "OK")
        self.assertIsNotNone(later_observation)
        assert later_observation is not None
        later_r = later_observation.features.get("r_final")
        self.assertIsNotNone(later_r)
        self.assertAlmostEqual(state["alignment_score"], 0.5 * 0.85 + 0.5 * float(later_r))
        self.assertEqual(state["obs_count"], 2)

    def test_related_feedback_respects_exemplar_cap(self) -> None:
        client = self._client(exemplar_cap=2)
        try:
            session_id = self._start_goal(client)
            first = self._notify(client, "Sourdough bread recipe")
            client.post(
                "/feedback",
                json={
                    "kind": "related",
                    "intervention_id": first["intervention_id"],
                    "observation_id": first["observation_id"],
                },
            )
            second = self._notify(client, "Mechanical keyboard deals")
            response = client.post(
                "/feedback",
                json={
                    "kind": "related",
                    "intervention_id": second["intervention_id"],
                    "observation_id": second["observation_id"],
                },
            ).json()
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(response["exemplar_count"], 2)
        self.assertEqual(self.store.goal_exemplar_count(session_id), 2)

    def test_snooze_feedback_updates_controller_and_blocks_next_intervention(self) -> None:
        client = self._client()
        try:
            session_id = self._start_goal(client)
            notification = self._notify(client)
            feedback = client.post(
                "/feedback",
                json={
                    "kind": "snooze",
                    "intervention_id": notification["intervention_id"],
                    "observation_id": notification["observation_id"],
                },
            ).json()
            next_drift = client.post(
                "/observations/browser-nav",
                json={
                    "source": "browser_nav",
                    "payload": {
                        "url": "https://example.com/travel-hotels",
                        "title": "Weekend hotel rankings",
                    },
                },
            ).json()
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(feedback["intervention_status"], "snoozed")
        self.assertIsNotNone(feedback["snoozed_until"])
        self.assertEqual(next_drift["verdict"], "DRIFT")
        self.assertEqual(next_drift["action"], "none")
        self.assertIsNotNone(self.store.get_controller_state(session_id).snoozed_until)

    def test_break_feedback_uses_five_minute_silence_and_marks_break(self) -> None:
        client = self._client(break_duration_seconds=300)
        try:
            session_id = self._start_goal(client)
            notification = self._notify(client)
            before = datetime.now(timezone.utc)
            feedback = client.post(
                "/feedback",
                json={
                    "kind": "break",
                    "intervention_id": notification["intervention_id"],
                    "observation_id": notification["observation_id"],
                },
            ).json()
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(feedback["intervention_status"], "break")
        self.assertIsNotNone(feedback["snoozed_until"])
        snoozed_until = datetime.fromisoformat(feedback["snoozed_until"])
        delta = (snoozed_until - before).total_seconds()
        self.assertGreater(delta, 290)
        self.assertLess(delta, 310)
        self.assertEqual(self.store.get_intervention(notification["intervention_id"]).status, "break")
        self.assertEqual(self.store.get_controller_state(session_id).snoozed_until, snoozed_until)

    def test_accepted_feedback_marks_intervention(self) -> None:
        client = self._client()
        try:
            self._start_goal(client)
            notification = self._notify(client)
            response = client.post(
                "/feedback",
                json={
                    "kind": "accepted",
                    "intervention_id": notification["intervention_id"],
                    "observation_id": notification["observation_id"],
                },
            ).json()
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(response["intervention_status"], "accepted")
        with closing(sqlite3.connect(self.db_path)) as conn:
            status = conn.execute("SELECT status FROM interventions WHERE id = ?", (notification["intervention_id"],)).fetchone()[0]
        self.assertEqual(status, "accepted")

    def test_clamp_notification_message_keeps_two_sentences(self) -> None:
        message = "첫 문장입니다. 둘째 문장입니다. 셋째 문장은 잘립니다."
        self.assertEqual(clamp_notification_message(message, 2), "첫 문장입니다. 둘째 문장입니다.")

    def test_clamp_does_not_split_domains_or_decimals(self) -> None:
        message = "또 youtube.com에 계시네요. 3.6 뢴트겐, 나쁘지 않습니다."
        self.assertEqual(clamp_notification_message(message, 2), message)

    def test_clamp_treats_stacked_marks_as_one_boundary(self) -> None:
        self.assertEqual(clamp_notification_message("세이프!! 돌아왔습니다!!", 2), "세이프!! 돌아왔습니다!!")
        self.assertEqual(clamp_notification_message("하나!! 둘!! 셋!!", 2), "하나!! 둘!!")

    def test_clamp_counts_boundaries_without_following_spaces(self) -> None:
        self.assertEqual(clamp_notification_message("하나!둘!셋!", 2), "하나! 둘!")
        self.assertEqual(clamp_notification_message("하나。둘。셋。", 2), "하나。 둘。")
        self.assertEqual(clamp_notification_message("하나.둘.셋.", 2), "하나. 둘.")

    def test_clamp_keeps_closing_brackets_and_quotes_with_sentence(self) -> None:
        self.assertEqual(clamp_notification_message("(진짜요?) 다음 문장입니다.", 1), "(진짜요?)")
        self.assertEqual(
            clamp_notification_message("\"정말입니다.\" 라고 말했다. 셋째 문장입니다.", 1),
            "\"정말입니다.\"",
        )

    def test_clamp_respects_three_sentence_budget(self) -> None:
        message = "제법이잖아. …차, 착각하지 마, 칭찬 아니야. 원래 했어야 할 일이잖아."
        self.assertEqual(clamp_notification_message(message, 3), message)


if __name__ == "__main__":
    unittest.main()
