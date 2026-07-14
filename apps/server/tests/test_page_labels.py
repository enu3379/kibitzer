import hashlib
import sqlite3
import tempfile
import unittest
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse
from unittest import mock

from fastapi.testclient import TestClient

from apps.server.app.config import AppConfig, ControllerConfig, ServerConfig, Tier1Config, Tier2Config
from apps.server.app.main import create_app
from apps.server.app.storage.sqlite import SQLiteStore


class PageLabelApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "kibitzer.sqlite3"
        self.store = SQLiteStore(self.db_path)

    def tearDown(self) -> None:
        self.tmpdir.cleanup()

    def _client(
        self,
        *,
        controller_type: str = "streak",
        theta_low: float = 0.15,
        theta_high: float = 0.3,
    ) -> TestClient:
        config = AppConfig(
            server=ServerConfig(db_path=str(self.db_path)),
            tier1=Tier1Config(enabled=False),
            tier2=Tier2Config(enabled=False),
            controller=ControllerConfig(
                type=controller_type,
                k=3,
                theta_low=theta_low,
                theta_high=theta_high,
                coldstart_observations=1,
                cooldown_seconds=0,
            ),
        )
        client = TestClient(create_app(config=config, store=self.store))
        client.__enter__()
        return client

    def _start_goal(self, client: TestClient) -> str:
        session_id = client.post("/sessions").json()["id"]
        client.post("/sessions/current/goal", json={"raw_text": "Kibitzer observation API"})
        return session_id

    def _post_nav(
        self,
        client: TestClient,
        title: str,
        tab_id: int,
        ts: datetime,
        *,
        url: str | None = None,
    ) -> dict[str, object]:
        response = client.post(
            "/observations/browser-nav",
            json={
                "source": "browser_nav",
                "ts": ts.isoformat(),
                "payload": {
                    "url": url or f"https://example.com/{title.lower().replace(' ', '-')}",
                    "title": title,
                    "tab_id": tab_id,
                },
            },
        )
        self.assertEqual(response.status_code, 200)
        return response.json()

    def _page_identity(self, title: str, tab_id: int) -> dict[str, str | int]:
        return self._url_identity(
            f"https://example.com/{title.lower().replace(' ', '-')}",
            tab_id,
        )

    def _url_identity(self, url: str, tab_id: int) -> dict[str, str | int]:
        parsed = urlparse(url)
        location = parsed.path or "/"
        if parsed.query:
            location += f"?{parsed.query}"
        if parsed.fragment:
            location += f"#{parsed.fragment}"
        return {
            "tab_id": tab_id,
            "url_host": parsed.hostname or "",
            "url_path_hash": hashlib.sha256(location.encode()).hexdigest(),
        }

    def test_latest_observation_for_tab_returns_verdict_and_diagnostics(self) -> None:
        client = self._client()
        base = datetime(2026, 7, 8, 0, 0, tzinfo=timezone.utc)
        try:
            self._start_goal(client)
            first = self._post_nav(client, "Sourdough bread recipe", 77, base)
            second = self._post_nav(client, "Kibitzer observation API docs", 77, base + timedelta(seconds=1))
            latest = client.get(
                "/observations/latest",
                params=self._page_identity("Kibitzer observation API docs", 77),
            )
            stale = client.get(
                "/observations/latest",
                params=self._page_identity("Sourdough bread recipe", 77),
            )
            missing = client.get(
                "/observations/latest",
                params=self._page_identity("Never observed", 88),
            )
            label_response = client.post(
                f"/observations/{second['observation_id']}/label",
                json={"label": "drift"},
            )
            relabeled = client.get(
                "/observations/latest",
                params=self._page_identity("Kibitzer observation API docs", 77),
            )
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(latest.status_code, 200)
        body = latest.json()
        self.assertEqual(body["observation_id"], second["observation_id"])
        self.assertEqual(body["title"], "Kibitzer observation API docs")
        self.assertEqual(body["url_host"], "example.com")
        self.assertEqual(body["verdict"], "OK")
        self.assertIn("r0", body["features"])
        self.assertIn("exemplar_score", body["features"])
        self.assertIn("anchor_eligible", body["features"])
        self.assertEqual(body["features"]["tier_reached"], 0)
        self.assertAlmostEqual(body["tau_ok"], 0.15)
        self.assertIsNone(body["label"])
        self.assertNotEqual(first["observation_id"], second["observation_id"])
        self.assertEqual(stale.status_code, 404)
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(relabeled.status_code, 200)
        self.assertEqual(relabeled.json()["label"], "drift")
        self.assertEqual(relabeled.json()["verdict"], "DRIFT")
        self.assertEqual(label_response.json()["verdict"], "DRIFT")
        # Replay/audit keeps the detector's original output even though the
        # product verdict exposed to the user is now DRIFT.
        self.assertEqual(self.store.get_observation(str(second["observation_id"])).verdict, "OK")

    def test_related_label_overrides_false_drift_and_clears_its_state(self) -> None:
        client = self._client()
        base = datetime(2026, 7, 8, 0, 0, tzinfo=timezone.utc)
        try:
            session_id = self._start_goal(client)
            observed = self._post_nav(client, "Sourdough bread recipe", 77, base)
            observation_id = str(observed["observation_id"])
            intervention_id = self.store.create_intervention(
                session_id,
                observation_id,
                "Drift detected.",
            )
            client.post(f"/interventions/{intervention_id}/delivery", json={"ok": True})

            before_state = client.get("/sessions/current/state").json()
            response = client.post(
                f"/observations/{observation_id}/label",
                json={"label": "related"},
            )
            latest = client.get(
                "/observations/latest",
                params=self._page_identity("Sourdough bread recipe", 77),
            ).json()
            stats = client.get("/sessions/current/stats").json()
            report = client.get("/sessions/current/report").json()
            daily = client.get(
                f"/reports/daily?date={base.astimezone().date().isoformat()}"
            ).json()
            after_state = client.get("/sessions/current/state").json()
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(observed["verdict"], "DRIFT")
        self.assertEqual(before_state["streak"], 1)
        self.assertIsNotNone(before_state["pending_intervention"])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["verdict"], "OK")
        self.assertEqual(latest["verdict"], "OK")
        self.assertEqual(latest["label"], "related")
        self.assertEqual(stats["ok"], 1)
        self.assertEqual(stats["drift"], 0)
        self.assertIsNone(stats["top_drift_host"])
        self.assertEqual(report["ok"], 1)
        self.assertEqual(report["drift"], 0)
        self.assertEqual(report["judgments"][0]["verdict"], "OK")
        self.assertEqual(daily["ok"], 1)
        self.assertEqual(daily["drift"], 0)
        self.assertEqual(after_state["streak"], 0)
        self.assertIsNone(after_state["pending_intervention"])
        self.assertEqual(self.store.get_intervention(intervention_id).status, "related")
        self.assertEqual(self.store.recent_observation_summaries(session_id, 1)[0].verdict, "OK")
        self.assertEqual(len(self.store.recent_ok_embeddings(session_id, 10)), 1)
        self.assertEqual(self.store.get_observation(observation_id).verdict, "DRIFT")

    def test_related_label_replaces_first_alignment_relevance_with_related_value(self) -> None:
        client = self._client(controller_type="alignment", theta_low=0.15, theta_high=0.3)
        base = datetime(2026, 7, 8, 0, 0, tzinfo=timezone.utc)
        try:
            self._start_goal(client)
            observed = self._post_nav(client, "Sourdough bread recipe", 77, base)
            before = client.get("/sessions/current/state").json()
            client.post(
                f"/observations/{observed['observation_id']}/label",
                json={"label": "related"},
            )
            after = client.get("/sessions/current/state").json()
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(observed["verdict"], "DRIFT")
        self.assertLess(before["alignment_score"], 0.15)
        self.assertAlmostEqual(after["alignment_score"], 0.85)
        self.assertEqual(after["streak"], 0)

    def test_related_label_recalculates_only_latest_alignment_contribution(self) -> None:
        client = self._client(controller_type="alignment", theta_low=0.15, theta_high=0.3)
        base = datetime(2026, 7, 8, 0, 0, tzinfo=timezone.utc)
        try:
            self._start_goal(client)
            self._post_nav(client, "Kibitzer observation API docs", 77, base)
            observed = self._post_nav(
                client,
                "Sourdough bread recipe",
                77,
                base + timedelta(seconds=1),
            )
            observation = self.store.get_observation(str(observed["observation_id"]))
            before = client.get("/sessions/current/state").json()
            client.post(
                f"/observations/{observed['observation_id']}/label",
                json={"label": "related"},
            )
            after = client.get("/sessions/current/state").json()
        finally:
            client.__exit__(None, None, None)

        self.assertIsNotNone(observation)
        previous_r = observation.features.get("r_final")
        self.assertIsNotNone(previous_r)
        expected = before["alignment_score"] + (1.0 - 0.85) * (0.85 - previous_r)
        self.assertAlmostEqual(after["alignment_score"], expected)
        self.assertEqual(after["obs_count"], before["obs_count"])

    def test_latest_observation_rejects_query_only_navigation(self) -> None:
        client = self._client()
        base = datetime(2026, 7, 8, 0, 0, tzinfo=timezone.utc)
        previous_url = "https://example.com/search?q=old#results"
        current_url = "https://example.com/search?q=new#results"
        try:
            self._start_goal(client)
            observed = self._post_nav(
                client,
                "Old search results",
                77,
                base,
                url=previous_url,
            )
            previous = client.get(
                "/observations/latest",
                params=self._url_identity(previous_url, 77),
            )
            stale = client.get(
                "/observations/latest",
                params=self._url_identity(current_url, 77),
            )
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(previous.status_code, 200)
        self.assertEqual(previous.json()["observation_id"], observed["observation_id"])
        self.assertEqual(stale.status_code, 404)

    def test_page_label_related_drift_related_keeps_one_synchronized_exemplar(self) -> None:
        client = self._client()
        base = datetime(2026, 7, 8, 0, 0, tzinfo=timezone.utc)
        try:
            session_id = self._start_goal(client)
            drift = self._post_nav(client, "Sourdough bread recipe", 77, base)
            observation_id = str(drift["observation_id"])

            related = client.post(
                f"/observations/{observation_id}/label",
                json={"label": "related"},
            )
            drift_label = client.post(
                f"/observations/{observation_id}/label",
                json={"label": "drift"},
            )
            count_after_drift = self.store.goal_exemplar_count(session_id)
            related_again = client.post(
                f"/observations/{observation_id}/label",
                json={"label": "related"},
            )
            duplicate = client.post(
                f"/observations/{observation_id}/label",
                json={"label": "related"},
            )
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(related.status_code, 200)
        self.assertEqual(related.json()["label"], "related")
        self.assertEqual(related.json()["exemplar_count"], 2)
        self.assertEqual(drift_label.status_code, 200)
        self.assertEqual(drift_label.json()["label"], "drift")
        self.assertIsNone(drift_label.json()["exemplar_count"])
        self.assertEqual(count_after_drift, 1)
        self.assertEqual(related_again.status_code, 200)
        self.assertEqual(related_again.json()["exemplar_count"], 2)
        self.assertEqual(duplicate.status_code, 200)
        self.assertEqual(duplicate.json()["exemplar_count"], 2)
        self.assertEqual(self.store.goal_exemplar_count(session_id), 2)

        with closing(sqlite3.connect(self.db_path)) as conn:
            rows = conn.execute("SELECT observation_id, label FROM page_labels").fetchall()
            learned_exemplars = conn.execute(
                """
                SELECT observation_id
                FROM goal_exemplars
                WHERE session_id = ? AND observation_id IS NOT NULL
                """,
                (session_id,),
            ).fetchall()
        self.assertEqual(rows, [(observation_id, "related")])
        self.assertEqual(learned_exemplars, [(observation_id,)])

    def test_page_label_and_exemplar_update_roll_back_together(self) -> None:
        client = self._client()
        base = datetime(2026, 7, 8, 0, 0, tzinfo=timezone.utc)
        try:
            session_id = self._start_goal(client)
            observed = self._post_nav(client, "Sourdough bread recipe", 77, base)
            observation_id = str(observed["observation_id"])

            with mock.patch.object(
                self.store,
                "_append_goal_exemplar_added_event",
                side_effect=RuntimeError("event write failed"),
            ):
                with self.assertRaisesRegex(RuntimeError, "event write failed"):
                    self.store.record_page_label(
                        session_id,
                        observation_id,
                        "related",
                        exemplar_cap=20,
                    )
        finally:
            client.__exit__(None, None, None)

        self.assertIsNone(self.store.page_label_for_observation(observation_id))
        self.assertEqual(self.store.goal_exemplar_count(session_id), 1)

    def test_page_label_rejects_observations_from_inactive_session(self) -> None:
        client = self._client()
        base = datetime(2026, 7, 8, 0, 0, tzinfo=timezone.utc)
        try:
            self._start_goal(client)
            observed = self._post_nav(client, "Sourdough bread recipe", 77, base)
            client.post("/sessions")
            response = client.post(
                f"/observations/{observed['observation_id']}/label",
                json={"label": "drift"},
            )
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(response.status_code, 404)


if __name__ == "__main__":
    unittest.main()
