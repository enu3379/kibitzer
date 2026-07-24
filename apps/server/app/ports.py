from __future__ import annotations

import json
import shutil
import socket
import subprocess
import sys
import threading
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any
from urllib.request import urlopen
from uuid import uuid4

from .build_info import build_info
from .runtime_paths import RuntimePaths, resolve_runtime_paths
from .server_lifecycle import (
    make_control_record,
    remove_if_instance_matches,
    watch_for_stop_request,
    write_control_record,
)

LOOPBACK_HOST = "127.0.0.1"
IDENTITY_PATH = "/identity"
_contract = json.loads(Path(__file__).with_name("port-candidates.json").read_text(encoding="utf-8"))
SERVICE_NAME = str(_contract["service"])
PROTOCOL_VERSION = int(_contract["protocol_version"])
PORT_CANDIDATES = tuple(int(port) for port in _contract["ports"])


class PortSelectionError(RuntimeError):
    def __init__(self, ports: Sequence[int], failures: Sequence[tuple[int, OSError]]) -> None:
        attempted = ", ".join(str(port) for port in ports)
        details = "; ".join(f"{port}: {error}" for port, error in failures)
        super().__init__(f"No Kibitzer port available. Attempted: {attempted}. {details}")


def identity_payload(instance_id: str) -> dict[str, str | int | None]:
    return {
        "service": SERVICE_NAME,
        "protocol_version": PROTOCOL_VERSION,
        "instance_id": instance_id,
        **build_info(),
    }


def is_kibitzer_identity(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and value.get("service") == SERVICE_NAME
        and value.get("protocol_version") == PROTOCOL_VERSION
        and isinstance(value.get("instance_id"), str)
        and bool(value["instance_id"])
    )


def probe_kibitzer(port: int, timeout_seconds: float = 0.4) -> bool:
    try:
        with urlopen(
            f"http://{LOOPBACK_HOST}:{port}{IDENTITY_PATH}",
            timeout=timeout_seconds,
        ) as response:
            if response.status != 200:
                return False
            payload = json.loads(response.read(4097))
    except (OSError, ValueError):
        return False
    return is_kibitzer_identity(payload)


def discover_existing_port(
    ports: Sequence[int] = PORT_CANDIDATES,
    probe: Callable[[int], bool] = probe_kibitzer,
) -> int | None:
    return next((port for port in ports if probe(port)), None)


def default_base_url() -> str:
    port = discover_existing_port() or PORT_CANDIDATES[0]
    return f"http://{LOOPBACK_HOST}:{port}"


def acquire_server_socket(
    ports: Sequence[int] = PORT_CANDIDATES,
    probe: Callable[[int], bool] = probe_kibitzer,
    socket_factory: Callable[[], socket.socket] = socket.socket,
) -> tuple[int, socket.socket | None]:
    existing = discover_existing_port(ports, probe)
    if existing is not None:
        return existing, None

    failures: list[tuple[int, OSError]] = []
    for port in ports:
        candidate = socket_factory()
        try:
            candidate.bind((LOOPBACK_HOST, port))
            candidate.listen(2048)
            return port, candidate
        except OSError as exc:
            failures.append((port, exc))
            candidate.close()
    raise PortSelectionError(ports, failures)


def write_effective_port(port: int, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.with_suffix(f"{path.suffix}.tmp")
    pending.write_text(f"{port}\n", encoding="utf-8")
    pending.replace(path)


def clear_effective_port(port: int, path: Path) -> None:
    try:
        if path.read_text(encoding="utf-8").strip() == str(port):
            path.unlink()
    except FileNotFoundError:
        pass


def port_owner_diagnostics(ports: Sequence[int]) -> list[str]:
    if sys.platform == "darwin":
        lsof = shutil.which("lsof")
        if not lsof:
            return []
        diagnostics: list[str] = []
        for port in ports:
            try:
                result = subprocess.run(
                    [lsof, "-nP", f"-iTCP:{port}", "-sTCP:LISTEN"],
                    capture_output=True,
                    text=True,
                    timeout=2,
                    check=False,
                )
            except (OSError, subprocess.TimeoutExpired):
                continue
            if result.stdout.strip():
                diagnostics.append(result.stdout.strip())
        return diagnostics
    if sys.platform == "win32":
        netstat = shutil.which("netstat")
        if not netstat:
            return []
        try:
            result = subprocess.run(
                [netstat, "-ano", "-p", "tcp"],
                capture_output=True,
                text=True,
                timeout=2,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return []
        return [
            line.strip()
            for line in result.stdout.splitlines()
            if "LISTENING" in line and any(f":{port} " in line for port in ports)
        ]
    return []


def main(runtime_paths: RuntimePaths | None = None) -> int:
    paths = runtime_paths or resolve_runtime_paths()
    effective_port_file = paths.effective_port_file
    effective_port_file.unlink(missing_ok=True)
    try:
        port, bound_socket = acquire_server_socket()
    except PortSelectionError as exc:
        print(str(exc), file=sys.stderr)
        for diagnostic in port_owner_diagnostics(PORT_CANDIDATES):
            print(diagnostic, file=sys.stderr)
        return 2

    write_effective_port(port, effective_port_file)
    if bound_socket is None:
        print(f"Kibitzer is already running on {LOOPBACK_HOST}:{port}")
        return 0

    instance_id = uuid4().hex
    stop_event = threading.Event()
    stop_watcher: threading.Thread | None = None
    try:
        import uvicorn

        from .main import create_app

        app = create_app(instance_id=instance_id)
        config = uvicorn.Config(
            app,
            host=LOOPBACK_HOST,
            port=port,
            timeout_graceful_shutdown=10,
        )
        server = uvicorn.Server(config)
        paths.server_stop_request_file.unlink(missing_ok=True)
        write_control_record(
            paths.server_control_file,
            make_control_record(
                service=SERVICE_NAME,
                protocol_version=PROTOCOL_VERSION,
                instance_id=instance_id,
                host=LOOPBACK_HOST,
                port=port,
            ),
        )
        stop_watcher = threading.Thread(
            target=watch_for_stop_request,
            args=(server, paths.server_stop_request_file, instance_id, stop_event),
            name="kibitzer-stop-watcher",
            daemon=True,
        )
        stop_watcher.start()
        server.run(sockets=[bound_socket])
    except KeyboardInterrupt:
        pass
    finally:
        stop_event.set()
        if stop_watcher is not None:
            stop_watcher.join(timeout=1)
        bound_socket.close()
        clear_effective_port(port, effective_port_file)
        remove_if_instance_matches(paths.server_stop_request_file, instance_id)
        remove_if_instance_matches(paths.server_control_file, instance_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
