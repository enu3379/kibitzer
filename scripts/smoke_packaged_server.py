#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.request import ProxyHandler, build_opener


STARTUP_TIMEOUT_SECONDS = 30.0
LOCAL_HTTP_OPENER = build_opener(ProxyHandler({}))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Smoke-test a Kibitzer PyInstaller onedir distribution"
    )
    parser.add_argument("--dist-dir", type=Path, required=True)
    return parser.parse_args()


def executable_in(dist_dir: Path) -> Path:
    name = "kibitzer-server.exe" if sys.platform == "win32" else "kibitzer"
    resolved_dist = dist_dir.resolve()
    executable = resolved_dist / name
    if not executable.is_file():
        raise RuntimeError(f"packaged executable not found: {executable}")
    if sys.platform == "win32" and not (resolved_dist / "Kibitzer.exe").is_file():
        raise RuntimeError(f"packaged tray executable not found: {resolved_dist / 'Kibitzer.exe'}")
    return executable


def smoke_windows_tray(dist_dir: Path, env: dict[str, str]) -> None:
    if sys.platform != "win32":
        return
    tray = dist_dir.resolve() / "Kibitzer.exe"
    result = subprocess.run(
        [str(tray), "--smoke"],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"packaged tray smoke failed with {result.returncode}: "
            f"stdout={result.stdout!r} stderr={result.stderr!r}"
        )


def run_json(executable: Path, args: list[str], env: dict[str, str]) -> dict[str, Any]:
    result = subprocess.run(
        [str(executable), *args],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"{' '.join(args)} failed with {result.returncode}: "
            f"stdout={result.stdout!r} stderr={result.stderr!r}"
        )
    return json.loads(result.stdout)


def wait_for_port(process: subprocess.Popen[str], port_file: Path) -> int:
    deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if process.poll() is not None:
            stdout, stderr = process.communicate()
            raise RuntimeError(
                f"packaged server exited with {process.returncode}: "
                f"stdout={stdout!r} stderr={stderr!r}"
            )
        try:
            port = int(port_file.read_text(encoding="utf-8").strip())
        except (FileNotFoundError, ValueError):
            time.sleep(0.1)
            continue
        if 1 <= port <= 65535:
            return port
        time.sleep(0.1)
    raise RuntimeError(f"timed out waiting for packaged server port file: {port_file}")


def fetch_json(url: str) -> dict[str, Any]:
    with LOCAL_HTTP_OPENER.open(url, timeout=3) as response:
        return json.loads(response.read())


def wait_for_json(process: subprocess.Popen[str], url: str) -> dict[str, Any]:
    deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            stdout, stderr = process.communicate()
            raise RuntimeError(
                f"packaged server exited with {process.returncode}: "
                f"stdout={stdout!r} stderr={stderr!r}"
            )
        try:
            return fetch_json(url)
        except (OSError, ValueError) as exc:
            last_error = exc
            time.sleep(0.1)
    raise RuntimeError(f"timed out waiting for {url}: {last_error}")


def stop_process(process: subprocess.Popen[str]) -> tuple[str, str]:
    if process.poll() is None:
        process.terminate()
        try:
            return process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
    return process.communicate(timeout=10)


def request_graceful_stop(
    control_file: Path,
    request_file: Path,
    instance_id: str,
) -> None:
    try:
        control = json.loads(control_file.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError) as exc:
        raise RuntimeError(f"packaged server did not publish {control_file}") from exc
    if control.get("instance_id") != instance_id:
        raise RuntimeError(f"control/identity instance mismatch: {control}")
    pending = request_file.with_suffix(f"{request_file.suffix}.tmp")
    pending.write_text(
        json.dumps(
            {
                "service": control.get("service"),
                "protocol_version": control.get("protocol_version"),
                "instance_id": instance_id,
            }
        ),
        encoding="utf-8",
    )
    pending.replace(request_file)


def smoke(dist_dir: Path) -> None:
    executable = executable_in(dist_dir)
    with tempfile.TemporaryDirectory(prefix="kibitzer-package-smoke-") as tmpdir:
        root = Path(tmpdir)
        profile = root / "profile"
        config_file = root / "smoke.yaml"
        config_file.write_text(
            """
server:
  db_path: ./data/kibitzer.sqlite3
embedding:
  provider: hash_cpu
  model: token-hash-v1
  dimensions: 256
tier1:
  enabled: false
tier2:
  enabled: false
""".strip()
            + "\n",
            encoding="utf-8",
        )

        env = dict(os.environ)
        env["KIBITZER_HOME"] = str(profile)
        paths = run_json(executable, ["paths"], env)
        smoke_windows_tray(dist_dir, env)
        if paths.get("mode") != "packaged":
            raise RuntimeError(f"expected packaged runtime mode, got {paths.get('mode')!r}")
        if Path(str(paths["data_dir"])) != profile:
            raise RuntimeError(f"packaged data path ignored KIBITZER_HOME: {paths['data_dir']}")
        for key in ("resource_root", "default_config_file"):
            if not Path(str(paths[key])).exists():
                raise RuntimeError(f"packaged resource is missing: {key}={paths[key]}")

        version_result = subprocess.run(
            [str(executable), "--version"],
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        )
        cli_version = version_result.stdout.strip().removeprefix("kibitzer ")
        if not cli_version:
            raise RuntimeError("packaged CLI returned an empty version")

        env["KIBITZER_CONFIG"] = str(config_file)
        process = subprocess.Popen(
            [str(executable), "serve"],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            port = wait_for_port(process, profile / "kibitzer.port")
            identity = wait_for_json(process, f"http://127.0.0.1:{port}/identity")
            health = wait_for_json(process, f"http://127.0.0.1:{port}/health")
            if identity.get("service") != "kibitzer":
                raise RuntimeError(f"unexpected identity payload: {identity}")
            if health.get("version") != cli_version:
                raise RuntimeError(
                    f"CLI/health version mismatch: {cli_version!r} != {health.get('version')!r}"
                )
            if health.get("mode") != "idle":
                raise RuntimeError(f"packaged server did not start idle: {health}")
            if not (profile / "kibitzer.sqlite3").is_file():
                raise RuntimeError("packaged server did not create its profile database")
        except Exception as exc:
            stdout, stderr = stop_process(process)
            raise RuntimeError(
                f"packaged server smoke failed: {exc}; "
                f"stdout={stdout!r} stderr={stderr!r}"
            ) from exc
        else:
            request_graceful_stop(
                Path(str(paths["server_control_file"])),
                Path(str(paths["server_stop_request_file"])),
                str(identity["instance_id"]),
            )
            try:
                stdout, stderr = process.communicate(timeout=15)
            except subprocess.TimeoutExpired as exc:
                stdout, stderr = stop_process(process)
                raise RuntimeError(
                    f"packaged server ignored graceful stop: stdout={stdout!r} stderr={stderr!r}"
                ) from exc
            if process.returncode != 0:
                raise RuntimeError(
                    f"packaged server stopped with {process.returncode}: "
                    f"stdout={stdout!r} stderr={stderr!r}"
                )

    print(f"Packaged server smoke passed: {executable}")


def main() -> int:
    args = parse_args()
    smoke(args.dist_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
