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
            raise RuntimeError("Kibitzer tray is already running")
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
    ) -> None:
        self.manager = manager or WindowsServerManager()
        self.instance_id = instance_id or uuid4().hex
        self._status = ServerStatus(ServerState.DEAD, "Kibitzer: starting tray")
        self._status_lock = threading.Lock()
        self._action_lock = threading.Lock()
        self._stop_event = threading.Event()
        self._icon: Any = None
        self._images: dict[ServerState, Any] = {}

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
        if not status.running:
            self._schedule("start", self.manager.start, ServerState.STARTING)
        self._poll_loop()

    def _poll_loop(self) -> None:
        while not self._stop_event.wait(POLL_SECONDS):
            request = read_json(self.manager.paths.tray_exit_request_file)
            if request and request.get("instance_id") == self.instance_id:
                self._request_exit()
                return
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
                self.manager.stop()
            finally:
                self._icon.stop()

        threading.Thread(target=stop_and_exit, name="kibitzer-tray-exit", daemon=True).start()

    def _schedule(
        self,
        name: str,
        action: Callable[[], bool],
        transition: ServerState,
    ) -> None:
        if not self._action_lock.acquire(blocking=False):
            return

        def run_action() -> None:
            try:
                self._set_status(ServerStatus(transition, f"Kibitzer: {transition.value}"))
                try:
                    succeeded = action()
                except Exception:
                    LOGGER.exception("tray %s action failed", name)
                    succeeded = False
                status = self.manager.status()
                if not succeeded and status.state is ServerState.DEAD:
                    status = ServerStatus(ServerState.DEAD, f"Kibitzer: {name} failed")
                self._set_status(status)
            finally:
                self._action_lock.release()

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
            icon.title = status.message
            icon.update_menu()

    def _status_text(self, _item: Any) -> str:
        with self._status_lock:
            return self._status.message

    def _can_start(self, _item: Any) -> bool:
        with self._status_lock:
            return self._status.state is ServerState.DEAD and not self._action_lock.locked()

    def _can_stop(self, _item: Any) -> bool:
        with self._status_lock:
            return self._status.running and not self._action_lock.locked()

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


def main() -> int:
    if sys.platform != "win32":
        print("The Kibitzer tray app is available on Windows only.", file=sys.stderr)
        return 2
    paths = resolve_runtime_paths()
    _configure_logging(paths)
    instance_id = uuid4().hex
    try:
        with WindowsSingleInstance():
            paths.tray_exit_request_file.unlink(missing_ok=True)
            atomic_write_json(
                paths.tray_control_file,
                {
                    "service": "kibitzer-tray",
                    "protocol_version": 1,
                    "instance_id": instance_id,
                    "pid": os.getpid(),
                    "executable": str(Path(sys.executable).resolve()),
                },
            )
            try:
                WindowsTrayApp(
                    WindowsServerManager(paths),
                    instance_id=instance_id,
                ).run()
            finally:
                remove_if_instance_matches(paths.tray_exit_request_file, instance_id)
                remove_if_instance_matches(paths.tray_control_file, instance_id)
    except RuntimeError as exc:
        LOGGER.info("%s", exc)
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
