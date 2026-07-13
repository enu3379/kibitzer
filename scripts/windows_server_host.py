from __future__ import annotations

import argparse
import asyncio
import contextlib
import ctypes
import json
import os
import sys
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import uvicorn


ROOT = Path(__file__).resolve().parents[1]
CONTROL_FILENAME = "windows-server-control.json"
STOP_REQUEST_FILENAME = "windows-server-stop-request.json"
WINDOWS_MUTEX_NAME = "Local\\KibitzerServerHost"


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    return value if isinstance(value, dict) else None


def _atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


def _remove_if_instance_matches(path: Path, instance_id: str) -> None:
    value = _read_json(path)
    if value and value.get("instance_id") == instance_id:
        path.unlink(missing_ok=True)


def _control_record(instance_id: str, host: str, port: int) -> dict[str, Any]:
    base_executable = getattr(sys, "_base_executable", sys.executable)
    return {
        "instance_id": instance_id,
        "pid": os.getpid(),
        "root": str(ROOT),
        "python_executable": str(Path(sys.executable).resolve()),
        "process_executable": str(Path(base_executable).resolve()),
        "host_script": str(Path(__file__).resolve()),
        "host": host,
        "port": port,
        "started_at": datetime.now(timezone.utc).isoformat(),
    }


@contextmanager
def _single_instance() -> Iterator[None]:
    if os.name != "nt":
        yield
        return

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateMutexW.argtypes = (ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p)
    kernel32.CreateMutexW.restype = ctypes.c_void_p
    kernel32.ReleaseMutex.argtypes = (ctypes.c_void_p,)
    kernel32.ReleaseMutex.restype = ctypes.c_bool
    kernel32.CloseHandle.argtypes = (ctypes.c_void_p,)
    kernel32.CloseHandle.restype = ctypes.c_bool
    handle = kernel32.CreateMutexW(None, True, WINDOWS_MUTEX_NAME)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
        kernel32.CloseHandle(handle)
        raise RuntimeError("Kibitzer Windows server host is already running")
    try:
        yield
    finally:
        kernel32.ReleaseMutex(handle)
        kernel32.CloseHandle(handle)


async def _watch_for_stop_request(
    server: uvicorn.Server,
    stop_request_path: Path,
    instance_id: str,
    poll_seconds: float = 0.25,
) -> None:
    while True:
        request = _read_json(stop_request_path)
        if request and request.get("instance_id") == instance_id:
            server.should_exit = True
            return
        await asyncio.sleep(poll_seconds)


async def _serve(host: str, port: int, runtime_dir: Path) -> None:
    runtime_dir.mkdir(parents=True, exist_ok=True)
    control_path = runtime_dir / CONTROL_FILENAME
    stop_request_path = runtime_dir / STOP_REQUEST_FILENAME

    with _single_instance():
        instance_id = uuid.uuid4().hex
        stop_request_path.unlink(missing_ok=True)
        watcher: asyncio.Task[None] | None = None
        try:
            _atomic_write_json(control_path, _control_record(instance_id, host, port))
            config = uvicorn.Config(
                "apps.server.app.main:app",
                host=host,
                port=port,
                timeout_graceful_shutdown=10,
            )
            server = uvicorn.Server(config)
            watcher = asyncio.create_task(
                _watch_for_stop_request(server, stop_request_path, instance_id)
            )
            await server.serve()
        finally:
            if watcher is not None:
                watcher.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await watcher
            _remove_if_instance_matches(stop_request_path, instance_id)
            _remove_if_instance_matches(control_path, instance_id)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the Kibitzer server with Windows tray stop control.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--runtime-dir", type=Path, default=ROOT / "data" / "logs")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    os.chdir(ROOT)
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    asyncio.run(_serve(args.host, args.port, args.runtime_dir.resolve()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
