from __future__ import annotations

import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Callable
from unittest.mock import ANY, patch

from apps.server.app.ports import PROTOCOL_VERSION, SERVICE_NAME
from apps.server.app.runtime_paths import RuntimePaths
from apps.server.app.server_lifecycle import atomic_write_json, read_json
from apps.server.app.windows_tray import (
    TRAY_PROTOCOL_VERSION,
    TRAY_SERVICE_NAME,
    WINDOWS_NOTIFICATION_APP_ID,
    ServerState,
    ServerStatus,
    TrayAlreadyRunningError,
    WindowsServerManager,
    WindowsToastNotifier,
    WindowsTrayApp,
    _tray_icon_path,
    main as windows_tray_main,
    request_existing_tray_attention,
)


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
WINDOWS_UNINSTALL_SCRIPT = REPOSITORY_ROOT / "scripts" / "windows_uninstall_startup_app.ps1"
WINDOWS_INSTALL_SCRIPT = REPOSITORY_ROOT / "scripts" / "windows_install_startup_app.ps1"
WINDOWS_STARTUP_FORWARDER = REPOSITORY_ROOT / "scripts" / "windows_startup_tray.ps1"


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

    def test_attention_request_times_out_without_a_matching_ack(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            paths = runtime_paths(Path(tmpdir))
            atomic_write_json(
                paths.tray_control_file,
                {
                    "service": TRAY_SERVICE_NAME,
                    "protocol_version": TRAY_PROTOCOL_VERSION,
                    "instance_id": "current",
                    "pid": 123,
                    "executable": "Kibitzer.exe",
                },
            )

            self.assertFalse(
                request_existing_tray_attention(paths, timeout_seconds=0)
            )
            request = read_json(paths.tray_attention_request_file)

        self.assertIsNotNone(request)
        self.assertEqual(request["service"], TRAY_SERVICE_NAME)
        self.assertEqual(request["protocol_version"], TRAY_PROTOCOL_VERSION)
        self.assertEqual(request["instance_id"], "current")
        self.assertTrue(request["request_id"])
        self.assertTrue(request["requested_at"])

    def test_attention_request_ignores_a_stale_ack(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            paths = runtime_paths(Path(tmpdir))
            atomic_write_json(
                paths.tray_control_file,
                {
                    "service": TRAY_SERVICE_NAME,
                    "protocol_version": TRAY_PROTOCOL_VERSION,
                    "instance_id": "current",
                },
            )
            atomic_write_json(
                paths.tray_attention_ack_file,
                {
                    "service": TRAY_SERVICE_NAME,
                    "protocol_version": TRAY_PROTOCOL_VERSION,
                    "instance_id": "current",
                    "request_id": "previous-request",
                },
            )

            self.assertFalse(
                request_existing_tray_attention(paths, timeout_seconds=0)
            )

    def test_attention_request_waits_for_the_current_tray_ack(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            paths = runtime_paths(Path(tmpdir))
            atomic_write_json(
                paths.tray_control_file,
                {
                    "service": TRAY_SERVICE_NAME,
                    "protocol_version": TRAY_PROTOCOL_VERSION,
                    "instance_id": "current",
                    "pid": 123,
                    "executable": "Kibitzer.exe",
                },
            )
            manager = SimpleNamespace(paths=paths)
            notify = unittest.mock.Mock(return_value=True)
            app = WindowsTrayApp(  # type: ignore[arg-type]
                manager,
                instance_id="current",
                notification_sender=notify,
            )
            app._status = ServerStatus(ServerState.IDLE, "Kibitzer: idle", 49187)
            result: list[bool] = []
            requester = threading.Thread(
                target=lambda: result.append(
                    request_existing_tray_attention(
                        paths,
                        timeout_seconds=0.5,
                        poll_seconds=0.005,
                    )
                )
            )
            requester.start()
            deadline = time.monotonic() + 0.25
            while (
                not paths.tray_attention_request_file.exists()
                and time.monotonic() < deadline
            ):
                time.sleep(0.005)

            app._consume_attention_request()
            requester.join(timeout=1)
            ack = read_json(paths.tray_attention_ack_file)

        self.assertFalse(requester.is_alive())
        self.assertEqual(result, [True])
        self.assertIsNotNone(ack)
        self.assertEqual(ack["instance_id"], "current")
        self.assertTrue(ack["request_id"])
        notify.assert_called_once()

    def test_attention_request_rejects_an_invalid_control_record(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            paths = runtime_paths(Path(tmpdir))
            atomic_write_json(
                paths.tray_control_file,
                {
                    "service": "not-kibitzer",
                    "protocol_version": TRAY_PROTOCOL_VERSION,
                    "instance_id": "stale",
                },
            )

            self.assertFalse(
                request_existing_tray_attention(paths, timeout_seconds=0)
            )
            self.assertFalse(paths.tray_attention_request_file.exists())


class WindowsTrayAppTest(unittest.TestCase):
    def test_winrt_notifier_reports_unrestricted_banner_delivery(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            toaster = SimpleNamespace(
                toastNotifier=SimpleNamespace(
                    setting=SimpleNamespace(value=0, name="ENABLED")
                ),
                show_toast=unittest.mock.Mock(),
            )
            notifier = WindowsToastNotifier(
                runtime_paths(Path(tmpdir)),
                toaster_factory=lambda app_id: (
                    toaster
                    if app_id == WINDOWS_NOTIFICATION_APP_ID
                    else self.fail("unexpected app id")
                ),
                toast_factory=lambda **kwargs: SimpleNamespace(**kwargs),
                notification_mode_getter=lambda: SimpleNamespace(
                    value=0,
                    name="UNRESTRICTED",
                ),
            )

            with (
                patch("apps.server.app.windows_tray.sys.platform", "win32"),
                patch.object(notifier, "_configure_identity") as configure,
            ):
                self.assertTrue(notifier.show("Kibitzer title", "Kibitzer message"))

            configure.assert_called_once_with()
            toast = toaster.show_toast.call_args.args[0]
            self.assertEqual(
                toast.text_fields,
                ["Kibitzer title", "Kibitzer message"],
            )

    def test_winrt_notifier_queues_toast_but_requests_fallback_in_priority_mode(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            toaster = SimpleNamespace(
                toastNotifier=SimpleNamespace(
                    setting=SimpleNamespace(value=0, name="ENABLED")
                ),
                show_toast=unittest.mock.Mock(),
            )
            notifier = WindowsToastNotifier(
                runtime_paths(Path(tmpdir)),
                toaster_factory=lambda _app_id: toaster,
                toast_factory=lambda **kwargs: SimpleNamespace(**kwargs),
                notification_mode_getter=lambda: SimpleNamespace(
                    value=1,
                    name="PRIORITY_ONLY",
                ),
            )

            with (
                patch("apps.server.app.windows_tray.sys.platform", "win32"),
                patch.object(notifier, "_configure_identity"),
            ):
                self.assertFalse(notifier.show("Kibitzer title", "Kibitzer message"))

            toaster.show_toast.assert_called_once()

    def test_winrt_notifier_reports_failure_after_show_returns(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            toaster = SimpleNamespace(
                toastNotifier=SimpleNamespace(
                    setting=SimpleNamespace(value=0, name="ENABLED")
                ),
                show_toast=unittest.mock.Mock(),
            )
            notifier = WindowsToastNotifier(
                runtime_paths(Path(tmpdir)),
                toaster_factory=lambda _app_id: toaster,
                toast_factory=lambda **kwargs: SimpleNamespace(**kwargs),
                notification_mode_getter=lambda: SimpleNamespace(
                    value=0,
                    name="UNRESTRICTED",
                ),
            )
            fallback = unittest.mock.Mock()

            with (
                patch("apps.server.app.windows_tray.sys.platform", "win32"),
                patch.object(notifier, "_configure_identity"),
            ):
                self.assertTrue(
                    notifier.show(
                        "Kibitzer title",
                        "Kibitzer message",
                        fallback,
                    )
                )

            toast = toaster.show_toast.call_args.args[0]
            toast.on_failed(SimpleNamespace(error_code=-1))
            fallback.assert_called_once_with()

    def test_manual_startup_notifies_the_current_server_status(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            manager = SimpleNamespace(paths=runtime_paths(Path(tmpdir)))
            manager.status = lambda: ServerStatus(ServerState.IDLE, "Kibitzer: idle", 49187)
            notify = unittest.mock.Mock(return_value=True)
            app = WindowsTrayApp(  # type: ignore[arg-type]
                manager,
                notify_on_startup=True,
                notification_sender=notify,
            )
            app._images = {state: object() for state in ServerState}
            icon = SimpleNamespace(
                visible=False,
                icon=None,
                title="",
                update_menu=lambda: None,
            )
            app._icon = icon

            with patch.object(app, "_poll_loop"):
                app._setup(icon)

            notify.assert_called_once_with(
                "Kibitzer is running",
                "Server status: idle on port 49187.",
                ANY,
            )
            self.assertEqual(icon.title, "Kibitzer: idle (port 49187)")

    def test_autostart_suppresses_the_success_notification(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            manager = SimpleNamespace(paths=runtime_paths(Path(tmpdir)))
            manager.status = lambda: ServerStatus(ServerState.IDLE, "Kibitzer: idle", 49187)
            notify = unittest.mock.Mock(return_value=True)
            app = WindowsTrayApp(  # type: ignore[arg-type]
                manager,
                notify_on_startup=False,
                notification_sender=notify,
            )
            app._images = {state: object() for state in ServerState}
            icon = SimpleNamespace(
                visible=False,
                icon=None,
                title="",
                update_menu=lambda: None,
            )
            app._icon = icon

            with patch.object(app, "_poll_loop"):
                app._setup(icon)

            notify.assert_not_called()

    def test_matching_attention_request_notifies_and_is_consumed(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            paths = runtime_paths(Path(tmpdir))
            manager = SimpleNamespace(paths=paths)
            notify = unittest.mock.Mock(return_value=True)
            app = WindowsTrayApp(  # type: ignore[arg-type]
                manager,
                instance_id="current",
                notification_sender=notify,
            )
            app._status = ServerStatus(ServerState.IDLE, "Kibitzer: idle", 49187)
            atomic_write_json(
                paths.tray_attention_request_file,
                {
                    "service": TRAY_SERVICE_NAME,
                    "protocol_version": TRAY_PROTOCOL_VERSION,
                    "instance_id": "current",
                    "request_id": "request-1",
                },
            )

            app._consume_attention_request()

            notify.assert_called_once_with(
                "Kibitzer is already running",
                "Server status: idle on port 49187. Use the existing tray icon to manage Kibitzer.",
                ANY,
            )
            self.assertFalse(paths.tray_attention_request_file.exists())
            ack = read_json(paths.tray_attention_ack_file)
            self.assertIsNotNone(ack)
            self.assertEqual(ack["request_id"], "request-1")

    def test_attention_notifications_are_coalesced_during_the_cooldown(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            paths = runtime_paths(Path(tmpdir))
            manager = SimpleNamespace(paths=paths)
            notify = unittest.mock.Mock(return_value=True)
            app = WindowsTrayApp(  # type: ignore[arg-type]
                manager,
                instance_id="current",
                notification_sender=notify,
            )
            app._status = ServerStatus(ServerState.IDLE, "Kibitzer: idle", 49187)

            with patch(
                "apps.server.app.windows_tray.time.monotonic",
                side_effect=(10.0, 11.0),
            ):
                for index in range(2):
                    atomic_write_json(
                        paths.tray_attention_request_file,
                        {
                            "service": TRAY_SERVICE_NAME,
                            "protocol_version": TRAY_PROTOCOL_VERSION,
                            "instance_id": "current",
                            "request_id": f"request-{index}",
                        },
                    )
                    app._consume_attention_request()

            notify.assert_called_once()
            self.assertFalse(paths.tray_attention_request_file.exists())
            ack = read_json(paths.tray_attention_ack_file)
            self.assertIsNotNone(ack)
            self.assertEqual(ack["request_id"], "request-1")

    def test_attention_request_must_match_the_current_tray_instance(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            paths = runtime_paths(Path(tmpdir))
            manager = SimpleNamespace(paths=paths)
            notify = unittest.mock.Mock(return_value=True)
            app = WindowsTrayApp(  # type: ignore[arg-type]
                manager,
                instance_id="current",
                notification_sender=notify,
            )
            atomic_write_json(
                paths.tray_attention_request_file,
                {
                    "service": TRAY_SERVICE_NAME,
                    "protocol_version": TRAY_PROTOCOL_VERSION,
                    "instance_id": "stale-or-reused",
                    "request_id": "request-1",
                },
            )

            app._consume_attention_request()

            notify.assert_not_called()
            self.assertTrue(paths.tray_attention_request_file.exists())

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
            notifications: list[tuple[str, str]] = []
            app = WindowsTrayApp(  # type: ignore[arg-type]
                manager,
                notification_sender=lambda title, message, _on_failure: (
                    notifications.append((title, message)) or True
                ),
            )
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
            while (
                app._action_lock.locked() or not notifications
            ) and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertFalse(app._action_lock.locked())
            self.assertFalse(menu_lock_states[-1])
            self.assertEqual(
                notifications,
                [
                    (
                        "Kibitzer server started",
                        "Server status: idle on port 49187.",
                    )
                ],
            )

    def test_failed_lifecycle_action_notifies_with_log_guidance(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            manager = SimpleNamespace(paths=runtime_paths(Path(tmpdir)))
            manager.status = lambda: ServerStatus(
                ServerState.DEAD,
                "Kibitzer: not running",
            )
            notify = unittest.mock.Mock(return_value=True)
            app = WindowsTrayApp(  # type: ignore[arg-type]
                manager,
                notification_sender=notify,
            )
            app._images = {state: object() for state in ServerState}
            app._icon = SimpleNamespace(
                icon=None,
                title="",
                update_menu=lambda: None,
            )

            app._schedule("restart", lambda: False, ServerState.STOPPING)
            deadline = time.monotonic() + 1
            while (
                app._action_lock.locked() or not notify.called
            ) and time.monotonic() < deadline:
                time.sleep(0.01)

            notify.assert_called_once_with(
                "Kibitzer could not restart the server",
                "Choose Open logs from the tray menu for details.",
                ANY,
            )

    def test_priority_mode_uses_visible_fallback_for_manual_startup(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            manager = SimpleNamespace(paths=runtime_paths(Path(tmpdir)))
            app = WindowsTrayApp(  # type: ignore[arg-type]
                manager,
                notification_sender=lambda _title, _message, _on_failure: False,
            )
            with patch(
                "apps.server.app.windows_tray._show_windows_message_async"
            ) as fallback:
                app._notify_startup(
                    ServerStatus(ServerState.IDLE, "Kibitzer: idle", 49187)
                )

            fallback.assert_called_once_with(
                "Kibitzer is running",
                "Server status: idle on port 49187.",
                error=False,
            )

    def test_synchronous_toast_failure_starts_only_one_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            manager = SimpleNamespace(paths=runtime_paths(Path(tmpdir)))

            def fail_delivery(
                _title: str,
                _message: str,
                on_failure: Callable[[], None] | None,
            ) -> bool:
                self.assertIsNotNone(on_failure)
                on_failure()
                return False

            app = WindowsTrayApp(  # type: ignore[arg-type]
                manager,
                notification_sender=fail_delivery,
            )
            with patch(
                "apps.server.app.windows_tray._show_windows_message_async"
            ) as fallback:
                app._notify(
                    "Kibitzer title",
                    "Kibitzer message",
                    ensure_visible=True,
                )

            fallback.assert_called_once_with(
                "Kibitzer title",
                "Kibitzer message",
                error=False,
            )


class WindowsTrayMainTest(unittest.TestCase):
    def test_duplicate_manual_launch_falls_back_when_tray_does_not_ack(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            paths = runtime_paths(Path(tmpdir))
            with (
                patch("apps.server.app.windows_tray.sys.platform", "win32"),
                patch("apps.server.app.windows_tray.sys.argv", ["Kibitzer.exe"]),
                patch(
                    "apps.server.app.windows_tray.resolve_runtime_paths",
                    return_value=paths,
                ),
                patch("apps.server.app.windows_tray._configure_logging"),
                patch(
                    "apps.server.app.windows_tray.WindowsSingleInstance.__enter__",
                    side_effect=TrayAlreadyRunningError("already running"),
                ),
                patch(
                    "apps.server.app.windows_tray.request_existing_tray_attention",
                    return_value=False,
                ) as request_attention,
                patch(
                    "apps.server.app.windows_tray._show_windows_message"
                ) as fallback,
            ):
                self.assertEqual(windows_tray_main(), 0)

            request_attention.assert_called_once_with(paths)
            fallback.assert_called_once_with(
                "Kibitzer is already running",
                "Use the existing icon in the Windows notification area to manage Kibitzer.",
                error=False,
            )


class WindowsUninstallSafetyTest(unittest.TestCase):
    def test_startup_launchers_mark_background_autostart(self) -> None:
        self.assertIn("--autostart", WINDOWS_INSTALL_SCRIPT.read_text(encoding="utf-8"))
        self.assertIn("--autostart", WINDOWS_STARTUP_FORWARDER.read_text(encoding="utf-8"))

    def test_install_migrates_the_legacy_startup_shortcut(self) -> None:
        script = WINDOWS_INSTALL_SCRIPT.read_text(encoding="utf-8")
        self.assertIn('"Kibitzer Server.lnk"', script)
        self.assertIn("Remove-Item -LiteralPath $LegacyShortcutPath", script)

    def test_install_registers_modern_notification_identity(self) -> None:
        script = WINDOWS_INSTALL_SCRIPT.read_text(encoding="utf-8")
        self.assertIn('"Kibitzer.Tray"', script)
        self.assertIn("AppUserModelId", script)
        self.assertIn('"DisplayName"', script)

    def test_uninstall_removes_modern_notification_identity(self) -> None:
        script = WINDOWS_UNINSTALL_SCRIPT.read_text(encoding="utf-8")
        self.assertIn('"Kibitzer.Tray"', script)
        self.assertIn("Remove-Item -LiteralPath $NotificationKey -Recurse", script)

    def test_uninstall_cleans_stale_attention_requests(self) -> None:
        script = WINDOWS_UNINSTALL_SCRIPT.read_text(encoding="utf-8")
        self.assertIn('"tray-attention-request.json"', script)
        self.assertIn('"tray-attention-ack.json"', script)
        self.assertIn("Remove-Item -LiteralPath $AttentionPath", script)
        self.assertIn("Remove-Item -LiteralPath $AttentionAckPath", script)

    def test_legacy_pid_file_is_cleanup_only_and_never_termination_authority(self) -> None:
        script = WINDOWS_UNINSTALL_SCRIPT.read_text(encoding="utf-8")

        for termination_command in ("Stop-Process", "taskkill", "TerminateProcess"):
            with self.subTest(termination_command=termination_command):
                self.assertNotIn(termination_command, script)
        self.assertIn("$LegacyPidFile", script)
        self.assertIn("Remove-Item -LiteralPath $LegacyPidFile", script)


if __name__ == "__main__":
    unittest.main()
