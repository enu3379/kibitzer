from __future__ import annotations

import ctypes
import json
import logging
import os
import subprocess
import sys
import threading
import time
from contextlib import AbstractContextManager
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Callable
from urllib.request import ProxyHandler, build_opener
from uuid import uuid4

from .ports import PORT_CANDIDATES, is_kibitzer_identity
from .runtime_paths import RuntimePaths, resolve_runtime_paths
from .server_lifecycle import (
    atomic_write_json,
    read_json,
    remove_if_instance_matches,
    request_server_stop,
    wait_for_server_exit,
)


LOGGER = logging.getLogger("kibitzer.windows_tray")
LOCAL_HTTP_OPENER = build_opener(ProxyHandler({}))
WINDOWS_MUTEX_NAME = "Local\\KibitzerTray"
POLL_SECONDS = 2.0
STARTUP_TIMEOUT_SECONDS = 30.0
STOP_TIMEOUT_SECONDS = 10.0
TRAY_SERVICE_NAME = "kibitzer-tray"
TRAY_PROTOCOL_VERSION = 1
ATTENTION_REQUEST_TIMEOUT_SECONDS = POLL_SECONDS + 1.0
ATTENTION_NOTIFICATION_COOLDOWN_SECONDS = 3.0
WINDOWS_NOTIFICATION_APP_ID = "Kibitzer.Tray"
WINDOWS_NOTIFICATION_APP_NAME = "Kibitzer"


NotificationFailureHandler = Callable[[], None]
NotificationSender = Callable[[str, str, NotificationFailureHandler | None], bool]


class TrayAlreadyRunningError(RuntimeError):
    pass


class ServerState(str, Enum):
    DEAD = "dead"
    STARTING = "starting"
    IDLE = "idle"
    ACTIVE = "active"
    UNKNOWN = "unknown"
    STOPPING = "stopping"


@dataclass(frozen=True)
class ServerStatus:
    state: ServerState
    message: str
    port: int | None = None

    @property
    def running(self) -> bool:
        return self.state in {ServerState.IDLE, ServerState.ACTIVE, ServerState.UNKNOWN}


def request_existing_tray_attention(
    paths: RuntimePaths,
    *,
    timeout_seconds: float = ATTENTION_REQUEST_TIMEOUT_SECONDS,
    poll_seconds: float = 0.05,
) -> bool:
    """Ask the current tray to surface itself and wait for its matching ack."""
    deadline = time.monotonic() + max(timeout_seconds, 0.0)
    while True:
        control = read_json(paths.tray_control_file)
        if control:
            try:
                service = str(control["service"])
                protocol_version = int(control["protocol_version"])
                instance_id = str(control["instance_id"])
            except (KeyError, TypeError, ValueError):
                pass
            else:
                if (
                    service == TRAY_SERVICE_NAME
                    and protocol_version == TRAY_PROTOCOL_VERSION
                    and instance_id
                ):
                    request_id = uuid4().hex
                    request_path = paths.tray_attention_request_file(request_id)
                    ack_path = paths.tray_attention_ack_file(request_id)
                    try:
                        atomic_write_json(
                            request_path,
                            {
                                "service": TRAY_SERVICE_NAME,
                                "protocol_version": TRAY_PROTOCOL_VERSION,
                                "instance_id": instance_id,
                                "request_id": request_id,
                                "requested_at": datetime.now(timezone.utc).isoformat(),
                            },
                        )
                    except OSError:
                        LOGGER.exception("could not request attention from the running tray")
                        return False

                    try:
                        while True:
                            if _attention_record_matches(
                                ack_path,
                                instance_id=instance_id,
                                request_id=request_id,
                            ):
                                return True
                            if time.monotonic() >= deadline:
                                # Cancellation races atomically with the tray's
                                # request -> ack rename. If cancellation wins,
                                # a late tray poll cannot surface a second
                                # notification after the local fallback.
                                if _remove_attention_record_if_matches(
                                    request_path,
                                    instance_id=instance_id,
                                    request_id=request_id,
                                ):
                                    return False
                                return _attention_record_matches(
                                    ack_path,
                                    instance_id=instance_id,
                                    request_id=request_id,
                                )
                            time.sleep(max(poll_seconds, 0.01))
                    finally:
                        _remove_attention_record_if_matches(
                            request_path,
                            instance_id=instance_id,
                            request_id=request_id,
                        )
                        _remove_attention_record_if_matches(
                            ack_path,
                            instance_id=instance_id,
                            request_id=request_id,
                        )
        if time.monotonic() >= deadline:
            return False
        time.sleep(max(poll_seconds, 0.01))


def _attention_record_matches(
    path: Path,
    *,
    instance_id: str,
    request_id: str,
) -> bool:
    value = read_json(path)
    return bool(
        value
        and value.get("service") == TRAY_SERVICE_NAME
        and value.get("protocol_version") == TRAY_PROTOCOL_VERSION
        and value.get("instance_id") == instance_id
        and value.get("request_id") == request_id
    )


def _remove_attention_record_if_matches(
    path: Path,
    *,
    instance_id: str,
    request_id: str,
) -> bool:
    if not _attention_record_matches(
        path,
        instance_id=instance_id,
        request_id=request_id,
    ):
        return False
    try:
        path.unlink()
    except FileNotFoundError:
        return False
    return True


def _clear_attention_records(
    paths: RuntimePaths,
    *,
    instance_id: str | None = None,
) -> None:
    try:
        records = tuple(paths.tray_attention_dir.glob("*.json"))
    except OSError:
        LOGGER.exception("could not list tray attention records")
        return
    for path in records:
        if instance_id is not None:
            value = read_json(path)
            if not value or value.get("instance_id") != instance_id:
                continue
        try:
            path.unlink(missing_ok=True)
        except OSError:
            LOGGER.exception("could not remove tray attention record %s", path)
    try:
        paths.tray_attention_dir.rmdir()
    except (FileNotFoundError, OSError):
        pass


def _show_windows_message(title: str, message: str, *, error: bool) -> None:
    if sys.platform != "win32":
        return
    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        user32.MessageBoxW.argtypes = (
            ctypes.c_void_p,
            ctypes.c_wchar_p,
            ctypes.c_wchar_p,
            ctypes.c_uint,
        )
        user32.MessageBoxW.restype = ctypes.c_int
        icon_flag = 0x00000010 if error else 0x00000040
        # Keep the fallback above other windows. It is used only when Windows
        # cannot present an ordinary toast banner (for example, Priority only
        # or Alarms only mode) or the WinRT delivery path fails.
        user32.MessageBoxW(
            None,
            message,
            title,
            icon_flag | 0x00010000 | 0x00040000,
        )
    except Exception:
        LOGGER.exception("could not show Windows message: %s", title)


def _show_windows_message_async(title: str, message: str, *, error: bool) -> None:
    if sys.platform != "win32":
        return
    threading.Thread(
        target=_show_windows_message,
        args=(title, message),
        kwargs={"error": error},
        name="kibitzer-notification-fallback",
        daemon=True,
    ).start()


class WindowsToastNotifier:
    """Deliver a modern WinRT toast and report whether a banner is expected."""

    def __init__(
        self,
        paths: RuntimePaths,
        *,
        toaster_factory: Callable[[str], Any] | None = None,
        toast_factory: Callable[..., Any] | None = None,
        notification_mode_getter: Callable[[], Any] | None = None,
    ) -> None:
        self.paths = paths
        self._toaster_factory = toaster_factory
        self._toast_factory = toast_factory
        self._notification_mode_getter = notification_mode_getter
        self._toaster: Any = None
        self._identity_configured = False

    def show(
        self,
        title: str,
        message: str,
        on_delivery_failure: NotificationFailureHandler | None = None,
    ) -> bool:
        """Queue a toast and return whether Windows should show its banner."""
        if sys.platform != "win32":
            return False
        try:
            self._ensure_initialized()
            try:
                setting = getattr(self._toaster.toastNotifier, "setting", None)
            except OSError:
                # A newly registered unpackaged AUMID can report
                # ERROR_ELEMENT_NOT_FOUND until its first toast creates the
                # per-app notification settings record. Delivery itself is
                # still valid, so treat the setting as unknown on that first
                # attempt and let WinRT create the record.
                LOGGER.info(
                    "Windows toast setting is not initialized for %s",
                    WINDOWS_NOTIFICATION_APP_ID,
                )
                setting = None
            setting_value = getattr(setting, "value", setting)
            if setting_value not in (None, 0):
                LOGGER.warning(
                    "Windows toast notifications are disabled for %s: %s",
                    WINDOWS_NOTIFICATION_APP_ID,
                    getattr(setting, "name", setting),
                )
                return False

            notification_mode = self._notification_mode()
            failure = threading.Event()

            def on_failed(event_args: Any) -> None:
                LOGGER.error(
                    "Windows toast delivery failed for %s: %s",
                    title,
                    getattr(event_args, "error_code", event_args),
                )
                failure.set()
                if on_delivery_failure is not None:
                    try:
                        on_delivery_failure()
                    except Exception:
                        LOGGER.exception(
                            "Windows toast failure handler failed for %s",
                            title,
                        )

            toast = self._toast_factory(
                text_fields=[title, message],
                on_failed=on_failed,
            )
            self._toaster.show_toast(toast)
            if failure.is_set():
                return False

            mode_name = getattr(notification_mode, "name", notification_mode)
            LOGGER.info(
                "queued Windows toast %r (notification mode: %s)",
                title,
                mode_name if mode_name is not None else "unavailable",
            )
            mode_value = getattr(notification_mode, "value", notification_mode)
            # On current Windows 11 builds, Priority only and Alarms only queue
            # ordinary app toasts into notification history but suppress their
            # banners. Returning False activates the visible fallback for
            # launch acknowledgements and failures.
            return mode_value in (None, 0)
        except Exception:
            LOGGER.exception("could not deliver Windows toast: %s", title)
            return False

    def _ensure_initialized(self) -> None:
        if not self._identity_configured:
            self._configure_identity()
            self._identity_configured = True
        if self._toaster is not None:
            return
        if self._toaster_factory is None or self._toast_factory is None:
            from windows_toasts import Toast, WindowsToaster

            self._toaster_factory = WindowsToaster
            self._toast_factory = Toast
        self._toaster = self._toaster_factory(WINDOWS_NOTIFICATION_APP_ID)

    def _notification_mode(self) -> Any:
        if self._notification_mode_getter is None:
            try:
                from winrt.windows.ui.notifications import ToastNotificationManager

                self._notification_mode_getter = (
                    lambda: ToastNotificationManager.get_default().notification_mode
                )
            except (ImportError, AttributeError, OSError):
                LOGGER.info("Windows notification mode is unavailable")
                return None
        try:
            return self._notification_mode_getter()
        except (AttributeError, OSError):
            LOGGER.info("Windows notification mode is unavailable", exc_info=True)
            return None

    def _configure_identity(self) -> None:
        import winreg

        shell32 = ctypes.WinDLL("shell32", use_last_error=True)
        set_app_id = shell32.SetCurrentProcessExplicitAppUserModelID
        set_app_id.argtypes = (ctypes.c_wchar_p,)
        set_app_id.restype = ctypes.c_long
        result = set_app_id(WINDOWS_NOTIFICATION_APP_ID)
        if result < 0:
            raise OSError(f"SetCurrentProcessExplicitAppUserModelID failed: {result}")

        key_path = rf"SOFTWARE\Classes\AppUserModelId\{WINDOWS_NOTIFICATION_APP_ID}"
        with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, key_path) as key:
            winreg.SetValueEx(
                key,
                "DisplayName",
                0,
                winreg.REG_SZ,
                WINDOWS_NOTIFICATION_APP_NAME,
            )
            winreg.SetValueEx(
                key,
                "IconUri",
                0,
                winreg.REG_SZ,
                str(_tray_icon_path(self.paths).resolve()),
            )
            winreg.SetValueEx(
                key,
                "IconBackgroundColor",
                0,
                winreg.REG_SZ,
                "FF111827",
            )


class WindowsServerManager:
    def __init__(
        self,
        paths: RuntimePaths | None = None,
        *,
        popen: Callable[..., subprocess.Popen[Any]] = subprocess.Popen,
        executable: Path | None = None,
    ) -> None:
        self.paths = paths or resolve_runtime_paths()
        self._popen = popen
        self._executable = executable
        self._child: subprocess.Popen[Any] | None = None
        self._lock = threading.Lock()

    def status(self) -> ServerStatus:
        for port in self._port_order():
            identity = self._fetch_json(f"http://127.0.0.1:{port}/identity")
            if not is_kibitzer_identity(identity):
                continue
            health = self._fetch_json(f"http://127.0.0.1:{port}/health")
            mode = health.get("mode") if isinstance(health, dict) else None
            if mode == "active":
                return ServerStatus(ServerState.ACTIVE, "Kibitzer: active", port)
            if mode == "idle":
                return ServerStatus(ServerState.IDLE, "Kibitzer: idle", port)
            return ServerStatus(ServerState.UNKNOWN, f"Kibitzer: {mode or 'unknown'}", port)
        return ServerStatus(ServerState.DEAD, "Kibitzer: not running")

    def start(self, *, timeout_seconds: float = STARTUP_TIMEOUT_SECONDS) -> bool:
        if self.status().running:
            return True
        command = self._server_command()
        self.paths.logs_dir.mkdir(parents=True, exist_ok=True)
        stdout_path = self.paths.logs_dir / "windows-server.out.log"
        stderr_path = self.paths.logs_dir / "windows-server.err.log"
        creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        with (
            stdout_path.open("a", encoding="utf-8") as stdout,
            stderr_path.open("a", encoding="utf-8") as stderr,
        ):
            try:
                child = self._popen(
                    command,
                    cwd=str(self._working_directory()),
                    stdout=stdout,
                    stderr=stderr,
                    stdin=subprocess.DEVNULL,
                    creationflags=creationflags,
                )
            except OSError:
                LOGGER.exception("could not start server command %s", command)
                return False
        with self._lock:
            self._child = child

        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            if child.poll() is not None:
                LOGGER.error("server child exited during startup with %s", child.returncode)
                return False
            if self.status().running:
                return True
            time.sleep(0.1)
        LOGGER.error("server did not become healthy within %.1f seconds", timeout_seconds)
        return False

    def stop(self, *, timeout_seconds: float = STOP_TIMEOUT_SECONDS) -> bool:
        status = self.status()
        if not status.running:
            return True
        record = request_server_stop(self.paths)
        if record is None:
            LOGGER.error("refusing to stop server without a matching identity/control record")
            return False
        graceful = wait_for_server_exit(record, timeout_seconds=timeout_seconds)
        with self._lock:
            child = self._child
        if graceful:
            if child is None or child.pid != record.pid or child.poll() is not None:
                return True
            try:
                child.wait(timeout=2)
                return True
            except subprocess.TimeoutExpired:
                pass

        # A PID read from disk is not termination authority. Only the exact
        # child object created by this manager may be force-terminated.
        if child is None or child.pid != record.pid or child.poll() is not None:
            LOGGER.error("graceful stop timed out; refusing unsafe PID-only termination")
            return False
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=5)
        return True

    def restart(self) -> bool:
        if not self.stop():
            return False
        return self.start()

    def open_logs(self) -> None:
        self.paths.logs_dir.mkdir(parents=True, exist_ok=True)
        if sys.platform == "win32":
            os.startfile(self.paths.logs_dir)  # type: ignore[attr-defined]
            return
        subprocess.Popen(["open", str(self.paths.logs_dir)])

    def _server_command(self) -> list[str]:
        if self._executable is not None:
            executable = self._executable
        elif self.paths.mode == "packaged":
            executable = Path(sys.executable).resolve().with_name("kibitzer-server.exe")
        else:
            executable = Path(sys.executable).resolve()
            if sys.platform == "win32" and executable.name.lower() == "pythonw.exe":
                # The tray itself uses pythonw, but the hidden child keeps the
                # console interpreter so stdout/stderr remain valid log streams.
                python = executable.with_name("python.exe")
                if python.is_file():
                    executable = python
        if self.paths.mode == "packaged" or self._executable is not None:
            return [str(executable), "serve"]
        return [str(executable), "-m", "apps.server.app.cli.main", "serve"]

    def _working_directory(self) -> Path:
        if self.paths.mode == "development":
            return self.paths.resource_root
        return Path(sys.executable).resolve().parent

    def _port_order(self) -> tuple[int, ...]:
        try:
            saved = int(self.paths.effective_port_file.read_text(encoding="utf-8").strip())
        except (FileNotFoundError, OSError, ValueError):
            return PORT_CANDIDATES
        if saved not in PORT_CANDIDATES:
            return PORT_CANDIDATES
        return (saved, *(port for port in PORT_CANDIDATES if port != saved))

    @staticmethod
    def _fetch_json(url: str, timeout_seconds: float = 0.5) -> dict[str, Any] | None:
        try:
            with LOCAL_HTTP_OPENER.open(url, timeout=timeout_seconds) as response:
                if response.status != 200:
                    return None
                value = json.loads(response.read(65537))
        except (OSError, ValueError):
            return None
        return value if isinstance(value, dict) else None


class WindowsSingleInstance(AbstractContextManager["WindowsSingleInstance"]):
    def __init__(self, name: str = WINDOWS_MUTEX_NAME) -> None:
        self.name = name
        self._kernel32: Any = None
        self._handle: Any = None

    def __enter__(self) -> WindowsSingleInstance:
        if sys.platform != "win32":
            return self
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateMutexW.argtypes = (ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p)
        kernel32.CreateMutexW.restype = ctypes.c_void_p
        kernel32.CloseHandle.argtypes = (ctypes.c_void_p,)
        kernel32.CloseHandle.restype = ctypes.c_bool
        handle = kernel32.CreateMutexW(None, False, self.name)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
            kernel32.CloseHandle(handle)
            raise TrayAlreadyRunningError("Kibitzer tray is already running")
        self._kernel32 = kernel32
        self._handle = handle
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        if self._kernel32 is not None and self._handle is not None:
            self._kernel32.CloseHandle(self._handle)
        self._kernel32 = None
        self._handle = None


class WindowsTrayApp:
    def __init__(
        self,
        manager: WindowsServerManager | None = None,
        *,
        instance_id: str | None = None,
        notify_on_startup: bool = True,
        notification_sender: NotificationSender | None = None,
    ) -> None:
        self.manager = manager or WindowsServerManager()
        self.instance_id = instance_id or uuid4().hex
        self.notify_on_startup = notify_on_startup
        self._status = ServerStatus(ServerState.DEAD, "Kibitzer: starting tray")
        self._status_lock = threading.Lock()
        self._action_lock = threading.Lock()
        self._stop_event = threading.Event()
        self._icon: Any = None
        self._images: dict[ServerState, Any] = {}
        self._last_attention_notification = float("-inf")
        self._notification_sender = (
            notification_sender or WindowsToastNotifier(self.manager.paths).show
        )

    def run(self) -> None:
        import pystray

        self._images = self._make_images()
        menu = pystray.Menu(
            pystray.MenuItem(self._status_text, None, enabled=False),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Start server", self._start, enabled=self._can_start),
            pystray.MenuItem("Stop server", self._stop, enabled=self._can_stop),
            pystray.MenuItem("Restart server", self._restart, enabled=self._can_stop),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Open logs", self._open_logs),
            pystray.MenuItem("Exit", self._exit),
        )
        self._icon = pystray.Icon(
            "Kibitzer",
            self._images[ServerState.UNKNOWN],
            "Kibitzer",
            menu,
        )
        self._icon.run(setup=self._setup)

    def _setup(self, icon: Any) -> None:
        icon.visible = True
        status = self.manager.status()
        self._set_status(status)
        if self.notify_on_startup:
            self._notify_startup(status)
        if not status.running:
            self._schedule(
                "start",
                self.manager.start,
                ServerState.STARTING,
                notify_success=False,
            )
        self._poll_loop()

    def _poll_loop(self) -> None:
        while not self._stop_event.wait(POLL_SECONDS):
            request = read_json(self.manager.paths.tray_exit_request_file)
            if request and request.get("instance_id") == self.instance_id:
                self._request_exit()
                return
            self._consume_attention_requests()
            if self._action_lock.locked():
                continue
            self._set_status(self.manager.status())

    def _start(self, _icon: Any, _item: Any) -> None:
        self._schedule("start", self.manager.start, ServerState.STARTING)

    def _stop(self, _icon: Any, _item: Any) -> None:
        self._schedule("stop", self.manager.stop, ServerState.STOPPING)

    def _restart(self, _icon: Any, _item: Any) -> None:
        self._schedule("restart", self.manager.restart, ServerState.STOPPING)

    def _open_logs(self, _icon: Any, _item: Any) -> None:
        threading.Thread(target=self.manager.open_logs, daemon=True).start()

    def _exit(self, _icon: Any, _item: Any) -> None:
        self._request_exit()

    def _request_exit(self) -> None:
        if self._stop_event.is_set():
            return
        self._stop_event.set()

        def stop_and_exit() -> None:
            try:
                with self._action_lock:
                    self.manager.stop()
            finally:
                self._icon.stop()

        threading.Thread(target=stop_and_exit, name="kibitzer-tray-exit", daemon=True).start()

    def _schedule(
        self,
        name: str,
        action: Callable[[], bool],
        transition: ServerState,
        *,
        notify_success: bool = True,
    ) -> None:
        if not self._action_lock.acquire(blocking=False):
            return

        def run_action() -> None:
            final_status = ServerStatus(ServerState.DEAD, f"Kibitzer: {name} failed")
            succeeded = False
            try:
                self._set_status(ServerStatus(transition, f"Kibitzer: {transition.value}"))
                try:
                    succeeded = action()
                except Exception:
                    LOGGER.exception("tray %s action failed", name)
                    succeeded = False
                try:
                    final_status = self.manager.status()
                except Exception:
                    LOGGER.exception("tray status refresh failed after %s", name)
                if not succeeded and final_status.state is ServerState.DEAD:
                    final_status = ServerStatus(
                        ServerState.DEAD,
                        f"Kibitzer: {name} failed",
                    )
            finally:
                self._action_lock.release()
            # Enabled menu properties consult the action lock, so refresh only
            # after releasing it. Otherwise every action leaves the buttons
            # disabled until the next polling interval.
            self._set_status(final_status)
            if succeeded:
                if notify_success:
                    self._notify_action_success(name, final_status)
            else:
                self._notify_action_failure(name)

        threading.Thread(
            target=run_action,
            name=f"kibitzer-tray-{name}",
            daemon=True,
        ).start()

    def _set_status(self, status: ServerStatus) -> None:
        with self._status_lock:
            self._status = status
        icon = self._icon
        if icon is not None:
            icon.icon = self._images.get(status.state, self._images[ServerState.UNKNOWN])
            icon.title = self._display_status(status)
            icon.update_menu()

    def _status_text(self, _item: Any) -> str:
        with self._status_lock:
            return self._display_status(self._status)

    def _can_start(self, _item: Any) -> bool:
        with self._status_lock:
            return self._status.state is ServerState.DEAD and not self._action_lock.locked()

    def _can_stop(self, _item: Any) -> bool:
        with self._status_lock:
            return self._status.running and not self._action_lock.locked()

    def _consume_attention_requests(self) -> None:
        try:
            request_paths = sorted(
                self.manager.paths.tray_attention_dir.glob("*.request.json")
            )
        except OSError:
            LOGGER.exception("could not list tray attention requests")
            return
        for request_path in request_paths:
            self._consume_attention_request(request_path)

    def _consume_attention_request(self, request_path: Path) -> None:
        request = read_json(request_path)
        request_id = request.get("request_id") if request else None
        if not request or (
            request.get("service") != TRAY_SERVICE_NAME
            or request.get("protocol_version") != TRAY_PROTOCOL_VERSION
            or request.get("instance_id") != self.instance_id
            or not isinstance(request_id, str)
            or not request_id
            or request_path
            != self.manager.paths.tray_attention_request_file(request_id)
        ):
            return
        ack_path = self.manager.paths.tray_attention_ack_file(request_id)
        try:
            request_path.replace(ack_path)
        except FileNotFoundError:
            # The requester timed out and canceled this exact request before
            # the tray could claim it. Do not show a late duplicate toast.
            return
        except OSError:
            LOGGER.exception("could not claim tray attention request %s", request_id)
            return
        now = time.monotonic()
        if now - self._last_attention_notification < ATTENTION_NOTIFICATION_COOLDOWN_SECONDS:
            return
        self._last_attention_notification = now
        with self._status_lock:
            status = self._status
        self._notify(
            "Kibitzer is already running",
            f"{self._status_summary(status)} Use the existing tray icon to manage Kibitzer.",
            ensure_visible=True,
        )

    def _notify_startup(self, status: ServerStatus) -> None:
        if status.running:
            self._notify(
                "Kibitzer is running",
                self._status_summary(status),
                ensure_visible=True,
            )
            return
        self._notify(
            "Kibitzer started",
            "The tray app is running and is starting the local server.",
            ensure_visible=True,
        )

    def _notify_action_success(self, name: str, status: ServerStatus) -> None:
        titles = {
            "start": "Kibitzer server started",
            "stop": "Kibitzer server stopped",
            "restart": "Kibitzer server restarted",
        }
        self._notify(titles.get(name, "Kibitzer action completed"), self._status_summary(status))

    def _notify_action_failure(self, name: str) -> None:
        verbs = {"start": "start", "stop": "stop", "restart": "restart"}
        verb = verbs.get(name, "update")
        self._notify(
            f"Kibitzer could not {verb} the server",
            "Choose Open logs from the tray menu for details.",
            ensure_visible=True,
            error=True,
        )

    def _notify(
        self,
        title: str,
        message: str,
        *,
        ensure_visible: bool = False,
        error: bool = False,
    ) -> None:
        fallback_lock = threading.Lock()
        fallback_started = False

        def show_fallback_once() -> None:
            nonlocal fallback_started
            if not ensure_visible:
                return
            with fallback_lock:
                if fallback_started:
                    return
                fallback_started = True
            _show_windows_message_async(title, message, error=error)

        try:
            banner_expected = self._notification_sender(
                title,
                message,
                show_fallback_once if ensure_visible else None,
            )
        except Exception:
            LOGGER.exception("notification sender failed: %s", title)
            banner_expected = False
        if ensure_visible and not banner_expected:
            show_fallback_once()

    @staticmethod
    def _display_status(status: ServerStatus) -> str:
        if status.port is None:
            return status.message
        return f"{status.message} (port {status.port})"

    @staticmethod
    def _status_summary(status: ServerStatus) -> str:
        if status.state is ServerState.DEAD:
            return "The local server is stopped."
        port = f" on port {status.port}" if status.port is not None else ""
        return f"Server status: {status.state.value}{port}."

    def _make_images(self) -> dict[ServerState, Any]:
        from PIL import Image, ImageDraw

        source = _tray_icon_path(self.manager.paths)
        base = Image.open(source).convert("RGBA").resize((64, 64))
        colors = {
            ServerState.DEAD: "#ef4444",
            ServerState.STARTING: "#eab308",
            ServerState.IDLE: "#9ca3af",
            ServerState.ACTIVE: "#22c55e",
            ServerState.UNKNOWN: "#eab308",
            ServerState.STOPPING: "#eab308",
        }
        images: dict[ServerState, Any] = {}
        for state, color in colors.items():
            image = base.copy()
            draw = ImageDraw.Draw(image)
            draw.ellipse((42, 42, 62, 62), fill=color, outline="#111827", width=2)
            images[state] = image
        return images


def _tray_icon_path(paths: RuntimePaths) -> Path:
    candidates = (
        paths.resource_root / "icons" / "tray.png",
        paths.resource_root / "icons" / "monitor-v1-mono-128.png",
        paths.resource_root
        / "apps"
        / "extension"
        / "icons"
        / "variants"
        / "monitor-v1-mono-128.png",
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise FileNotFoundError("Kibitzer tray icon resource is missing")


def _configure_logging(paths: RuntimePaths) -> None:
    paths.logs_dir.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        filename=paths.logs_dir / "windows-tray.log",
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )


def _smoke_packaged_tray(paths: RuntimePaths) -> None:
    import pystray  # noqa: F401
    import windows_toasts  # noqa: F401
    from winrt.windows.ui import notifications as winrt_notifications  # noqa: F401

    manager = WindowsServerManager(paths)
    WindowsTrayApp(manager)._make_images()
    server_executable = Path(manager._server_command()[0])
    if not server_executable.is_file():
        raise FileNotFoundError(f"bundled server executable is missing: {server_executable}")


def main() -> int:
    if sys.platform != "win32":
        print("The Kibitzer tray app is available on Windows only.", file=sys.stderr)
        return 2
    paths = resolve_runtime_paths()
    autostart = "--autostart" in sys.argv[1:]
    _configure_logging(paths)
    if "--smoke" in sys.argv[1:]:
        try:
            _smoke_packaged_tray(paths)
        except Exception:
            LOGGER.exception("Windows tray package smoke failed")
            return 1
        return 0
    instance_id = uuid4().hex
    try:
        with WindowsSingleInstance():
            paths.tray_exit_request_file.unlink(missing_ok=True)
            _clear_attention_records(paths)
            atomic_write_json(
                paths.tray_control_file,
                {
                    "service": TRAY_SERVICE_NAME,
                    "protocol_version": TRAY_PROTOCOL_VERSION,
                    "instance_id": instance_id,
                    "pid": os.getpid(),
                    "executable": str(Path(sys.executable).resolve()),
                },
            )
            try:
                WindowsTrayApp(
                    WindowsServerManager(paths),
                    instance_id=instance_id,
                    notify_on_startup=not autostart,
                ).run()
            finally:
                remove_if_instance_matches(paths.tray_exit_request_file, instance_id)
                _clear_attention_records(paths, instance_id=instance_id)
                remove_if_instance_matches(paths.tray_control_file, instance_id)
    except TrayAlreadyRunningError as exc:
        LOGGER.info("%s", exc)
        if not autostart and not request_existing_tray_attention(paths):
            _show_windows_message(
                "Kibitzer is already running",
                "Use the existing icon in the Windows notification area to manage Kibitzer.",
                error=False,
            )
        return 0
    except Exception:
        LOGGER.exception("Windows tray failed")
        _show_windows_message(
            "Kibitzer could not start",
            f"Open the Kibitzer logs for details:\n{paths.logs_dir}",
            error=True,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
