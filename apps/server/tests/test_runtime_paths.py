from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from apps.server.app.config import load_config
from apps.server.app.runtime_paths import resolve_runtime_paths


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


class RuntimePathsTest(unittest.TestCase):
    def test_development_paths_do_not_depend_on_current_working_directory(self) -> None:
        previous_cwd = Path.cwd()
        with tempfile.TemporaryDirectory() as tmpdir:
            try:
                os.chdir(tmpdir)
                paths = resolve_runtime_paths(environ={})
                config = load_config(runtime_paths=paths)
            finally:
                os.chdir(previous_cwd)

        self.assertEqual(paths.mode, "development")
        self.assertEqual(paths.resource_root, REPOSITORY_ROOT)
        self.assertEqual(paths.data_dir, REPOSITORY_ROOT / "data")
        self.assertEqual(paths.default_config_file, REPOSITORY_ROOT / "configs" / "default.yaml")
        self.assertEqual(config.server.db_path, str(REPOSITORY_ROOT / "data" / "kibitzer.sqlite3"))
        self.assertEqual(
            config.privacy.sensitive_domains_file,
            str(REPOSITORY_ROOT / "configs" / "sensitive_domains.json"),
        )

    def test_windows_packaged_paths_use_local_app_data(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            resources = root / "bundle"
            local_app_data = root / "LocalAppData"
            paths = resolve_runtime_paths(
                environ={"LOCALAPPDATA": str(local_app_data)},
                platform="win32",
                home=root / "home",
                frozen=True,
                resource_root=resources,
            )

        self.assertEqual(paths.mode, "packaged")
        self.assertEqual(paths.resource_root, resources)
        self.assertEqual(paths.data_dir, local_app_data / "Kibitzer")
        self.assertEqual(paths.user_config_dir, local_app_data / "Kibitzer" / "configs")
        self.assertEqual(paths.effective_port_file, local_app_data / "Kibitzer" / "kibitzer.port")
        self.assertEqual(
            paths.server_control_file,
            local_app_data / "Kibitzer" / "server-control.json",
        )
        self.assertEqual(paths.logs_dir, local_app_data / "Kibitzer" / "logs")

    def test_macos_packaged_paths_use_application_support(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            home = root / "home"
            paths = resolve_runtime_paths(
                environ={},
                platform="darwin",
                home=home,
                frozen=True,
                resource_root=root / "bundle",
            )

        expected = home / "Library" / "Application Support" / "Kibitzer"
        self.assertEqual(paths.data_dir, expected)
        self.assertEqual(paths.env_file, expected / ".env")
        self.assertEqual(paths.custom_personas_file, expected / "configs" / "personas.yaml")

    def test_home_and_config_overrides_are_explicit(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            profile = root / "profile"
            config_file = root / "custom.yaml"
            paths = resolve_runtime_paths(
                environ={
                    "KIBITZER_HOME": str(profile),
                    "KIBITZER_CONFIG": str(config_file),
                },
                home=root / "home",
                frozen=False,
                resource_root=REPOSITORY_ROOT,
            )

        self.assertEqual(paths.mode, "development")
        self.assertEqual(paths.data_dir, profile)
        self.assertEqual(paths.user_config_dir, profile / "configs")
        self.assertEqual(paths.default_config_file, config_file)
        self.assertEqual(paths.env_file, profile / ".env")
        self.assertTrue(paths.config_file_explicit)

    def test_missing_explicit_config_override_fails_fast(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            missing = root / "typo.yaml"
            paths = resolve_runtime_paths(
                environ={
                    "KIBITZER_HOME": str(root / "profile"),
                    "KIBITZER_CONFIG": str(missing),
                },
                home=root / "home",
                frozen=True,
                resource_root=root / "bundle",
            )

            with self.assertRaisesRegex(
                FileNotFoundError,
                "Explicit Kibitzer config file does not exist",
            ):
                load_config(runtime_paths=paths)

    def test_yaml_memory_database_is_not_rewritten_as_a_profile_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            config_file = root / "memory.yaml"
            config_file.write_text("server:\n  db_path: ':memory:'\n", encoding="utf-8")
            paths = resolve_runtime_paths(
                environ={"KIBITZER_HOME": str(root / "profile")},
                home=root / "home",
                frozen=True,
                resource_root=root / "bundle",
            )

            config = load_config(config_file, runtime_paths=paths)

        self.assertEqual(config.server.db_path, ":memory:")

    def test_packaged_config_separates_writable_and_bundled_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir).resolve()
            resources = root / "bundle"
            config_dir = resources / "configs"
            config_dir.mkdir(parents=True)
            (config_dir / "default.yaml").write_text(
                """
server:
  db_path: ./data/kibitzer.sqlite3
embedding:
  provider: onnx_cpu
  model: ./data/models/model.onnx
  tokenizer_path: ./data/models/tokenizer.json
tier1:
  experiment_models_file: configs/models.local.yaml
tier2:
  experiment_models_file: configs/models.local.yaml
privacy:
  sensitive_domains_file: configs/sensitive_domains.json
delivery:
  personas_file: configs/personas.yaml
  custom_personas_file: ~/.kibitzer/personas.yaml
""".strip()
                + "\n",
                encoding="utf-8",
            )
            profile = root / "profile"
            paths = resolve_runtime_paths(
                environ={"KIBITZER_HOME": str(profile)},
                platform="win32",
                home=root / "home",
                frozen=True,
                resource_root=resources,
            )
            config = load_config(runtime_paths=paths)

        self.assertEqual(config.server.db_path, str(profile / "kibitzer.sqlite3"))
        self.assertEqual(config.embedding.model, str(profile / "models" / "model.onnx"))
        self.assertEqual(
            config.embedding.tokenizer_path,
            str(profile / "models" / "tokenizer.json"),
        )
        self.assertEqual(
            config.tier1.experiment_models_file,
            str(profile / "configs" / "models.local.yaml"),
        )
        self.assertEqual(
            config.tier2.experiment_models_file,
            str(profile / "configs" / "models.local.yaml"),
        )
        self.assertEqual(
            config.privacy.sensitive_domains_file,
            str(resources / "configs" / "sensitive_domains.json"),
        )
        self.assertEqual(
            config.delivery.personas_file,
            str(resources / "configs" / "personas.yaml"),
        )
        self.assertEqual(
            config.delivery.custom_personas_file,
            str(profile / "configs" / "personas.yaml"),
        )


if __name__ == "__main__":
    unittest.main()
