from __future__ import annotations

import io
import json
import tempfile
import tomllib
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from apps.server.app.cli.main import main
from apps.server.app.runtime_paths import RuntimePaths, RuntimePathsError
from apps.server.app.version import APP_VERSION, SOURCE_VERSION


class CliTest(unittest.TestCase):
    def test_default_and_serve_commands_start_server(self) -> None:
        paths = self._paths()
        for argv in ([], ["serve"]):
            with self.subTest(argv=argv), patch(
                "apps.server.app.cli.main.resolve_runtime_paths",
                return_value=paths,
            ), patch("apps.server.app.cli.main.serve", return_value=7) as serve:
                self.assertEqual(main(argv), 7)
                serve.assert_called_once_with(paths)

    def test_paths_prints_machine_readable_diagnostics(self) -> None:
        paths = self._paths()
        output = io.StringIO()
        with patch(
            "apps.server.app.cli.main.resolve_runtime_paths",
            return_value=paths,
        ), redirect_stdout(output):
            self.assertEqual(main(["paths"]), 0)

        self.assertEqual(json.loads(output.getvalue()), paths.diagnostics())

    def test_version_is_non_empty(self) -> None:
        output = io.StringIO()
        with self.assertRaises(SystemExit) as raised, redirect_stdout(output):
            main(["--version"])

        self.assertEqual(raised.exception.code, 0)
        self.assertEqual(output.getvalue().strip(), f"kibitzer {APP_VERSION}")
        self.assertTrue(APP_VERSION)

    def test_non_editable_install_error_is_actionable_without_traceback(self) -> None:
        error = io.StringIO()
        with patch(
            "apps.server.app.cli.main.resolve_runtime_paths",
            side_effect=RuntimePathsError("Could not locate Kibitzer repository resources"),
        ), redirect_stderr(error), self.assertRaises(SystemExit) as raised:
            main(["paths"])

        self.assertEqual(raised.exception.code, 2)
        self.assertIn("editable repository checkout", error.getvalue())
        self.assertIn("packaged distribution", error.getvalue())
        self.assertNotIn("Traceback", error.getvalue())

    def test_packaged_source_version_matches_project_metadata(self) -> None:
        pyproject = tomllib.loads(
            (Path(__file__).resolve().parents[3] / "pyproject.toml").read_text(encoding="utf-8")
        )

        self.assertEqual(SOURCE_VERSION, pyproject["project"]["version"])

    @staticmethod
    def _paths() -> RuntimePaths:
        root = Path(tempfile.gettempdir()) / "kibitzer-cli-test"
        return RuntimePaths(
            mode="development",
            resource_root=root,
            data_dir=root / "data",
            control_dir=root / "data" / "runtime",
            user_config_dir=root / "configs",
            default_config_file=root / "configs" / "default.yaml",
            env_file=root / ".env",
            custom_personas_file=root / "personas.yaml",
        )


if __name__ == "__main__":
    unittest.main()
