from __future__ import annotations

import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from apps.server.app.ports import PROTOCOL_VERSION, SERVICE_NAME
from apps.server.app.runtime_paths import RuntimePaths
from apps.server.app.windows_tray import (
    ServerState,
    ServerStatus,
    WindowsServerManager,
    WindowsTrayApp,
    _tray_icon_path,
)


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
WINDOWS_UNINSTALL_SCRIPT = REPOSITORY_ROOT / "scripts" / "windows_uninstall_startup_app.ps1"


def runtime_paths(root: Path, *, mode: str = "development") -> RuntimePaths:
    return RuntimePaths(
        mode=mode,  # type: ignore[arg-type]
        resource_root=root,
        data_dir=root / "data",
        control_dir=root / "data" / "runtime",
        user_config_dir=root / "configs",
        default_config_file=root / "configs" / "default.yaml",
        env_file=root / ".env",
        custom_personas_file=root / "personas.yaml",
    )


class WindowsServerManagerTest(unittest.TestCase):
    def test_packaged_tray_icon_uses_bundled_resource_name(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            icon = root / "icons" / "monitor-v1-mono-128.png"
            icon.parent.mkdir()
            icon.touch()
            self.assertEqual(_tray_icon_path(runtime_paths(root, mode="packaged")), icon)

    def test_status_discovers_candidate_and_maps_health_mode(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            manager = WindowsServerManager(runtime_paths(Path(tmpdir)))

            def fetch(url: str, timeout_seconds: float = 0.5):
                if ":51387/identity" in url:
                    return {
                        "service": SERVICE_NAME,
                        "protocol_version": PROTOCOL_VERSION,
                        "instance_id": "server",
                    }
                if ":51387/health" in url:
                    return {"mode": "idle"}
                return None

            with patch.object(manager, "_fetch_json", side_effect=fetch):
                self.assertEqual(
                    manager.status(),
                    ServerStatus(ServerState.IDLE, "Kibitzer: idle", 51387),
                )

    def test_development_and_packaged_server_commands_are_distinct(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            development = WindowsServerManager(runtime_paths(root))
            self.assertEqual(development._server_command()[1:4], ["-m", "apps.server.app.cli.main", "serve"])

            packaged = WindowsServerManager(runtime_paths(root, mode="packaged"))
            self.assertEqual(packaged._server_command()[-1], "serve")
            self.assertTrue(packaged._server_command()[0].endswith("kibitzer-server.exe"))

    def test_development_tray_uses_console_python_for_hidden_logged_child(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            pythonw = root / "pythonw.exe"
            python = root / "python.exe"
            python.touch()
            manager = WindowsServerManager(runtime_paths(root))
            with (
                patch("apps.server.app.windows_tray.sys.platform", "win32"),
                patch("apps.server.app.windows_tray.sys.executable", str(pythonw)),
            ):
                command = manager._server_command()
            self.assertEqual(command[0], str(python.resolve()))

    def test_stop_never_terminates_from_an_unverified_control_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            manager = WindowsServerManager(runtime_paths(Path(tmpdir)))
            child = SimpleNamespace(pid=123, terminate=unittest.mock.Mock())
            manager._child = child  # type: ignore[assignment]
            with (
                patch.object(
                    manager,
                    "status",
                    return_value=ServerStatus(ServerState.IDLE, "idle", 49187),
                ),
                patch(
                    "apps.server.app.windows_tray.request_server_stop",
                    return_value=None,
                ),
            ):
                self.assertFalse(manager.stop())
            child.terminate.assert_not_called()


class WindowsTrayAppTest(unittest.TestCase):
    def test_exit_request_must_match_the_current_tray_instance(self) -> None:
        class TwoIterationStopEvent:
            def __init__(self) -> None:
                self.calls = 0

            def wait(self, _timeout: float) -> bool:
                self.calls += 1
                return self.calls > 1

        with tempfile.TemporaryDirectory() as tmpdir:
            manager = SimpleNamespace(paths=runtime_paths(Path(tmpdir)))
            manager.status = lambda: ServerStatus(ServerState.IDLE, "idle", 49187)
            app = WindowsTrayApp(manager, instance_id="current")  # type: ignore[arg-type]
            app._stop_event = TwoIterationStopEvent()  # type: ignore[assignment]
            with (
                patch(
                    "apps.server.app.windows_tray.read_json",
                    return_value={"instance_id": "stale-or-reused"},
                ),
                patch.object(app, "_request_exit") as request_exit,
            ):
                app._poll_loop()

            request_exit.assert_not_called()

    def test_matching_exit_request_stops_the_current_tray_instance(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            manager = SimpleNamespace(paths=runtime_paths(Path(tmpdir)))
            app = WindowsTrayApp(manager, instance_id="current")  # type: ignore[arg-type]
            with (
                patch(
                    "apps.server.app.windows_tray.read_json",
                    return_value={"instance_id": "current"},
                ),
                patch("apps.server.app.windows_tray.POLL_SECONDS", 0),
                patch.object(app, "_request_exit") as request_exit,
            ):
                app._poll_loop()

            request_exit.assert_called_once_with()

    def test_lifecycle_callback_returns_without_waiting_for_action(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            manager = SimpleNamespace(paths=runtime_paths(Path(tmpdir)))
            app = WindowsTrayApp(manager)  # type: ignore[arg-type]
            app._images = {state: object() for state in ServerState}
            menu_lock_states: list[bool] = []
            app._icon = SimpleNamespace(
                icon=None,
                title="",
                update_menu=lambda: menu_lock_states.append(app._action_lock.locked()),
            )
            entered = threading.Event()
            release = threading.Event()

            def slow_action() -> bool:
                entered.set()
                release.wait(1)
                return True

            manager.status = lambda: ServerStatus(ServerState.IDLE, "idle", 49187)
            started = time.monotonic()
            app._schedule("start", slow_action, ServerState.STARTING)
            elapsed = time.monotonic() - started
            self.assertLess(elapsed, 0.1)
            self.assertTrue(entered.wait(0.5))
            self.assertTrue(app._action_lock.locked())
            release.set()
            deadline = time.monotonic() + 1
            while app._action_lock.locked() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertFalse(app._action_lock.locked())
            self.assertFalse(menu_lock_states[-1])


class WindowsUninstallSafetyTest(unittest.TestCase):
    def test_legacy_pid_file_is_cleanup_only_and_never_termination_authority(self) -> None:
        script = WINDOWS_UNINSTALL_SCRIPT.read_text(encoding="utf-8")

        for termination_command in ("Stop-Process", "taskkill", "TerminateProcess"):
            with self.subTest(termination_command=termination_command):
                self.assertNotIn(termination_command, script)
        self.assertIn("$LegacyPidFile", script)
        self.assertIn("Remove-Item -LiteralPath $LegacyPidFile", script)


if __name__ == "__main__":
    unittest.main()
