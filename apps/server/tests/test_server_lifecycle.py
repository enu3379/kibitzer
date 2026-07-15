from __future__ import annotations

import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from apps.server.app.ports import PROTOCOL_VERSION, SERVICE_NAME
from apps.server.app.runtime_paths import RuntimePaths
from apps.server.app.server_lifecycle import (
    ServerControlRecord,
    atomic_write_json,
    make_control_record,
    read_json,
    remove_if_instance_matches,
    request_server_stop,
    wait_for_server_exit,
    watch_for_stop_request,
)


def runtime_paths(root: Path) -> RuntimePaths:
    return RuntimePaths(
        mode="packaged",
        resource_root=root / "bundle",
        data_dir=root / "profile",
        user_config_dir=root / "profile" / "configs",
        default_config_file=root / "bundle" / "configs" / "default.yaml",
        env_file=root / "profile" / ".env",
        custom_personas_file=root / "profile" / "configs" / "personas.yaml",
    )


class ServerLifecycleTest(unittest.TestCase):
    def test_atomic_json_and_owner_scoped_cleanup(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "control.json"
            atomic_write_json(path, {"instance_id": "first", "pid": 10})
            self.assertEqual(read_json(path), {"instance_id": "first", "pid": 10})

            remove_if_instance_matches(path, "other")
            self.assertTrue(path.exists())
            remove_if_instance_matches(path, "first")
            self.assertFalse(path.exists())

    def test_control_record_validation_rejects_non_loopback_or_bad_protocol(self) -> None:
        record = make_control_record(
            service=SERVICE_NAME,
            protocol_version=PROTOCOL_VERSION,
            instance_id="instance",
            host="127.0.0.1",
            port=49187,
        )
        value = record.__dict__
        self.assertEqual(
            ServerControlRecord.from_value(
                value,
                service=SERVICE_NAME,
                protocol_version=PROTOCOL_VERSION,
            ),
            record,
        )
        self.assertIsNone(
            ServerControlRecord.from_value(
                {**value, "host": "0.0.0.0"},
                service=SERVICE_NAME,
                protocol_version=PROTOCOL_VERSION,
            )
        )
        self.assertIsNone(
            ServerControlRecord.from_value(
                {**value, "protocol_version": 99},
                service=SERVICE_NAME,
                protocol_version=PROTOCOL_VERSION,
            )
        )

    def test_stop_request_requires_control_identity_match(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            paths = runtime_paths(Path(tmpdir))
            record = make_control_record(
                service=SERVICE_NAME,
                protocol_version=PROTOCOL_VERSION,
                instance_id="current",
                host="127.0.0.1",
                port=49187,
            )
            atomic_write_json(paths.server_control_file, record.__dict__)

            with patch(
                "apps.server.app.server_lifecycle.probe_identity",
                return_value={
                    "service": SERVICE_NAME,
                    "protocol_version": PROTOCOL_VERSION,
                    "instance_id": "newer",
                },
            ):
                self.assertIsNone(request_server_stop(paths))
            self.assertFalse(paths.server_stop_request_file.exists())

            with patch(
                "apps.server.app.server_lifecycle.probe_identity",
                return_value={
                    "service": SERVICE_NAME,
                    "protocol_version": PROTOCOL_VERSION,
                    "instance_id": "current",
                },
            ):
                self.assertEqual(request_server_stop(paths), record)
            self.assertEqual(
                read_json(paths.server_stop_request_file)["instance_id"],  # type: ignore[index]
                "current",
            )

    def test_watcher_ignores_stale_request_and_stops_matching_instance(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "stop.json"
            server = SimpleNamespace(should_exit=False)
            done = threading.Event()
            atomic_write_json(path, {"instance_id": "stale"})
            watcher = threading.Thread(
                target=watch_for_stop_request,
                args=(server, path, "current", done),
                kwargs={"poll_seconds": 0.01},
            )
            watcher.start()
            threading.Event().wait(0.03)
            self.assertFalse(server.should_exit)

            atomic_write_json(path, {"instance_id": "current"})
            watcher.join(timeout=0.25)
            self.assertFalse(watcher.is_alive())
            self.assertTrue(server.should_exit)

    def test_exit_wait_ignores_transient_identity_miss(self) -> None:
        record = make_control_record(
            service=SERVICE_NAME,
            protocol_version=PROTOCOL_VERSION,
            instance_id="current",
            host="127.0.0.1",
            port=49187,
        )
        identities = [
            None,
            {
                "service": SERVICE_NAME,
                "protocol_version": PROTOCOL_VERSION,
                "instance_id": "current",
            },
            None,
            None,
            None,
            None,
            None,
        ]
        with patch(
            "apps.server.app.server_lifecycle.probe_identity",
            side_effect=identities,
        ):
            self.assertTrue(
                wait_for_server_exit(record, timeout_seconds=1, poll_seconds=0.001)
            )


if __name__ == "__main__":
    unittest.main()
