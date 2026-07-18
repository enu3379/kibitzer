from __future__ import annotations

import os
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal


RuntimeMode = Literal["development", "packaged"]


class RuntimePathsError(RuntimeError):
    pass


@dataclass(frozen=True)
class RuntimePaths:
    mode: RuntimeMode
    resource_root: Path
    data_dir: Path
    control_dir: Path
    user_config_dir: Path
    default_config_file: Path
    env_file: Path
    custom_personas_file: Path
    config_file_explicit: bool = False

    @property
    def effective_port_file(self) -> Path:
        return self.data_dir / "kibitzer.port"

    @property
    def server_control_file(self) -> Path:
        return self.control_dir / "server-control.json"

    @property
    def server_stop_request_file(self) -> Path:
        return self.control_dir / "server-stop-request.json"

    @property
    def tray_control_file(self) -> Path:
        return self.control_dir / "tray-control.json"

    @property
    def tray_exit_request_file(self) -> Path:
        return self.control_dir / "tray-exit-request.json"

    @property
    def tray_attention_request_file(self) -> Path:
        return self.control_dir / "tray-attention-request.json"

    @property
    def logs_dir(self) -> Path:
        return self.data_dir / "logs"

    @property
    def database_file(self) -> Path:
        return self.data_dir / "kibitzer.sqlite3"

    @property
    def models_dir(self) -> Path:
        return self.data_dir / "models"

    @property
    def experiment_models_file(self) -> Path:
        return self.user_config_dir / "models.local.yaml"

    def diagnostics(self) -> dict[str, str]:
        return {
            "mode": self.mode,
            "resource_root": str(self.resource_root),
            "data_dir": str(self.data_dir),
            "control_dir": str(self.control_dir),
            "user_config_dir": str(self.user_config_dir),
            "default_config_file": str(self.default_config_file),
            "env_file": str(self.env_file),
            "database_file": str(self.database_file),
            "models_dir": str(self.models_dir),
            "experiment_models_file": str(self.experiment_models_file),
            "custom_personas_file": str(self.custom_personas_file),
            "effective_port_file": str(self.effective_port_file),
            "server_control_file": str(self.server_control_file),
            "server_stop_request_file": str(self.server_stop_request_file),
            "tray_control_file": str(self.tray_control_file),
            "tray_exit_request_file": str(self.tray_exit_request_file),
            "tray_attention_request_file": str(self.tray_attention_request_file),
            "logs_dir": str(self.logs_dir),
        }


def resolve_runtime_paths(
    *,
    environ: Mapping[str, str] | None = None,
    platform: str | None = None,
    home: Path | None = None,
    frozen: bool | None = None,
    resource_root: Path | None = None,
    module_file: Path | None = None,
) -> RuntimePaths:
    environment = os.environ if environ is None else environ
    platform_name = sys.platform if platform is None else platform
    home_dir = Path.home() if home is None else home
    is_frozen = bool(getattr(sys, "frozen", False)) if frozen is None else frozen

    if resource_root is None:
        if is_frozen:
            bundle_root = getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent)
            resource_root = Path(bundle_root)
        else:
            resource_root = _find_repository_root(module_file or Path(__file__))
    resource_root = resource_root.expanduser().resolve()

    home_override = environment.get("KIBITZER_HOME")
    if home_override:
        data_dir = _absolute_path(home_override, home_dir)
    elif is_frozen:
        data_dir = _platform_data_dir(
            platform=platform_name,
            environ=environment,
            home=home_dir,
        )
    else:
        data_dir = resource_root / "data"

    uses_user_profile = is_frozen or bool(home_override)
    user_config_dir = data_dir / "configs" if uses_user_profile else resource_root / "configs"
    env_file = data_dir / ".env" if uses_user_profile else resource_root / ".env"
    custom_personas_file = (
        user_config_dir / "personas.yaml"
        if uses_user_profile
        else home_dir / ".kibitzer" / "personas.yaml"
    )

    config_override = environment.get("KIBITZER_CONFIG")
    default_config_file = (
        _absolute_path(config_override, home_dir)
        if config_override
        else resource_root / "configs" / "default.yaml"
    )
    if platform_name == "win32" and not home_override:
        # Development worktrees keep their own databases/config, but all
        # Windows launchers must be able to stop the one currently listening
        # Kibitzer server before switching worktrees.
        control_dir = _platform_data_dir(
            platform=platform_name,
            environ=environment,
            home=home_dir,
        ) / "runtime"
    else:
        control_dir = data_dir / "runtime"

    return RuntimePaths(
        mode="packaged" if is_frozen else "development",
        resource_root=resource_root,
        data_dir=data_dir,
        control_dir=control_dir,
        user_config_dir=user_config_dir,
        default_config_file=default_config_file,
        env_file=env_file,
        custom_personas_file=custom_personas_file,
        config_file_explicit=bool(config_override),
    )


def _find_repository_root(module_file: Path) -> Path:
    resolved = module_file.expanduser().resolve()
    for candidate in resolved.parents:
        if (candidate / "pyproject.toml").is_file() and (
            candidate / "configs" / "default.yaml"
        ).is_file():
            return candidate
    raise RuntimePathsError(f"Could not locate Kibitzer repository resources from {resolved}")


def _platform_data_dir(
    *,
    platform: str,
    environ: Mapping[str, str],
    home: Path,
) -> Path:
    if platform == "win32":
        local_app_data = environ.get("LOCALAPPDATA")
        base = Path(local_app_data).expanduser() if local_app_data else home / "AppData" / "Local"
        return base / "Kibitzer"
    if platform == "darwin":
        return home / "Library" / "Application Support" / "Kibitzer"

    xdg_data_home = environ.get("XDG_DATA_HOME")
    base = Path(xdg_data_home).expanduser() if xdg_data_home else home / ".local" / "share"
    return base / "Kibitzer"


def _absolute_path(value: str, home: Path) -> Path:
    if value == "~":
        path = home
    elif value.startswith("~/") or value.startswith("~\\"):
        path = home / value[2:]
    else:
        path = Path(value).expanduser()
    return path if path.is_absolute() else (Path.cwd() / path).resolve()
