import asyncio
import sys
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace

import pytest

from scripts import windows_server_host


def test_control_json_round_trip_accepts_utf8_bom(tmp_path) -> None:
    path = tmp_path / windows_server_host.CONTROL_FILENAME
    path.write_text('\ufeff{"instance_id":"abc"}', encoding="utf-8")

    assert windows_server_host._read_json(path) == {"instance_id": "abc"}


def test_atomic_write_and_instance_cleanup(tmp_path) -> None:
    path = tmp_path / windows_server_host.CONTROL_FILENAME
    windows_server_host._atomic_write_json(path, {"instance_id": "first", "pid": 10})
    assert windows_server_host._read_json(path) == {"instance_id": "first", "pid": 10}

    windows_server_host._remove_if_instance_matches(path, "other")
    assert path.exists()

    windows_server_host._remove_if_instance_matches(path, "first")
    assert not path.exists()


def test_control_record_distinguishes_venv_and_process_executables() -> None:
    record = windows_server_host._control_record("instance", "127.0.0.1", 8765)

    assert record["python_executable"] == str(Path(sys.executable).resolve())
    assert record["process_executable"] == str(
        Path(getattr(sys, "_base_executable", sys.executable)).resolve()
    )
    assert record["instance_id"] == "instance"
    assert record["port"] == 8765


@pytest.mark.asyncio
async def test_stop_watcher_ignores_other_instance_then_stops_match(tmp_path) -> None:
    path = tmp_path / windows_server_host.STOP_REQUEST_FILENAME
    server = SimpleNamespace(should_exit=False)
    windows_server_host._atomic_write_json(path, {"instance_id": "other"})

    watcher = asyncio.create_task(
        windows_server_host._watch_for_stop_request(server, path, "target", poll_seconds=0.01)
    )
    await asyncio.sleep(0.03)
    assert server.should_exit is False

    windows_server_host._atomic_write_json(path, {"instance_id": "target"})
    await asyncio.wait_for(watcher, timeout=0.25)
    assert server.should_exit is True


@pytest.mark.asyncio
async def test_serve_cleans_instance_files_when_uvicorn_initialization_fails(
    tmp_path, monkeypatch
) -> None:
    control_path = tmp_path / windows_server_host.CONTROL_FILENAME
    stop_request_path = tmp_path / windows_server_host.STOP_REQUEST_FILENAME

    def fail_config(*args, **kwargs):
        control = windows_server_host._read_json(control_path)
        assert control is not None
        windows_server_host._atomic_write_json(
            stop_request_path, {"instance_id": control["instance_id"]}
        )
        raise RuntimeError("config failed")

    monkeypatch.setattr(windows_server_host, "_single_instance", nullcontext)
    monkeypatch.setattr(windows_server_host.uvicorn, "Config", fail_config)

    with pytest.raises(RuntimeError, match="config failed"):
        await windows_server_host._serve("127.0.0.1", 8765, tmp_path)

    assert not control_path.exists()
    assert not stop_request_path.exists()
