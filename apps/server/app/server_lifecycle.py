from __future__ import annotations

import json
import os
import sys
import threading
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol
from urllib.request import ProxyHandler, build_opener
from uuid import uuid4

from .runtime_paths import RuntimePaths


LOCAL_HTTP_OPENER = build_opener(ProxyHandler({}))


class UvicornServer(Protocol):
    should_exit: bool


@dataclass(frozen=True)
class ServerControlRecord:
    service: str
    protocol_version: int
    instance_id: str
    pid: int
    host: str
    port: int
    executable: str
    started_at: str

    @classmethod
    def from_value(
        cls,
        value: Any,
        *,
        service: str,
        protocol_version: int,
    ) -> ServerControlRecord | None:
        if not isinstance(value, dict):
            return None
        try:
            record = cls(
                service=str(value["service"]),
                protocol_version=int(value["protocol_version"]),
                instance_id=str(value["instance_id"]),
                pid=int(value["pid"]),
                host=str(value["host"]),
                port=int(value["port"]),
                executable=str(value["executable"]),
                started_at=str(value["started_at"]),
            )
        except (KeyError, TypeError, ValueError):
            return None
        if (
            record.service != service
            or record.protocol_version != protocol_version
            or not record.instance_id
            or record.pid < 1
            or record.host != "127.0.0.1"
            or not 1 <= record.port <= 65535
            or not record.executable
            or not record.started_at
        ):
            return None
        return record


def make_control_record(
    *,
    service: str,
    protocol_version: int,
    instance_id: str,
    host: str,
    port: int,
) -> ServerControlRecord:
    return ServerControlRecord(
        service=service,
        protocol_version=protocol_version,
        instance_id=instance_id,
        pid=os.getpid(),
        host=host,
        port=port,
        executable=str(Path(sys.executable).resolve()),
        started_at=datetime.now(timezone.utc).isoformat(),
    )


def read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    return value if isinstance(value, dict) else None


def atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.with_name(f"{path.name}.{os.getpid()}.{uuid4().hex}.tmp")
    pending.write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    pending.replace(path)


def write_control_record(path: Path, record: ServerControlRecord) -> None:
    atomic_write_json(path, asdict(record))


def remove_if_instance_matches(path: Path, instance_id: str) -> None:
    value = read_json(path)
    if value and value.get("instance_id") == instance_id:
        path.unlink(missing_ok=True)


def probe_identity(
    host: str,
    port: int,
    *,
    timeout_seconds: float = 0.4,
) -> dict[str, Any] | None:
    try:
        with LOCAL_HTTP_OPENER.open(
            f"http://{host}:{port}/identity",
            timeout=timeout_seconds,
        ) as response:
            if response.status != 200:
                return None
            value = json.loads(response.read(4097))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def verified_control_record(paths: RuntimePaths) -> ServerControlRecord | None:
    # Imported lazily to avoid a module cycle: ports owns the public wire
    # contract, while ports imports this module to host the stop watcher.
    from .ports import PROTOCOL_VERSION, SERVICE_NAME, is_kibitzer_identity

    record = ServerControlRecord.from_value(
        read_json(paths.server_control_file),
        service=SERVICE_NAME,
        protocol_version=PROTOCOL_VERSION,
    )
    if record is None:
        return None
    identity = probe_identity(record.host, record.port)
    if not is_kibitzer_identity(identity) or identity["instance_id"] != record.instance_id:
        return None
    return record


def request_server_stop(paths: RuntimePaths) -> ServerControlRecord | None:
    record = verified_control_record(paths)
    if record is None:
        return None
    atomic_write_json(
        paths.server_stop_request_file,
        {
            "service": record.service,
            "protocol_version": record.protocol_version,
            "instance_id": record.instance_id,
            "requested_at": datetime.now(timezone.utc).isoformat(),
        },
    )
    return record


def wait_for_server_exit(
    record: ServerControlRecord,
    *,
    timeout_seconds: float = 10.0,
    poll_seconds: float = 0.1,
) -> bool:
    deadline = time.monotonic() + timeout_seconds
    consecutive_misses = 0
    while time.monotonic() < deadline:
        identity = probe_identity(record.host, record.port)
        if identity is None or identity.get("instance_id") != record.instance_id:
            consecutive_misses += 1
            if consecutive_misses >= 5:
                return True
        else:
            consecutive_misses = 0
        time.sleep(poll_seconds)
    return False


def watch_for_stop_request(
    server: UvicornServer,
    path: Path,
    instance_id: str,
    stop_event: threading.Event,
    *,
    poll_seconds: float = 0.1,
) -> None:
    while not stop_event.wait(poll_seconds):
        request = read_json(path)
        if request and request.get("instance_id") == instance_id:
            server.should_exit = True
            return
