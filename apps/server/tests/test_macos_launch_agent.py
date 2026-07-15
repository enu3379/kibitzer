from __future__ import annotations

import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
INSTALL_SCRIPT = REPOSITORY_ROOT / "scripts" / "macos_install_launch_agent.sh"
UNINSTALL_SCRIPT = REPOSITORY_ROOT / "scripts" / "macos_uninstall_launch_agent.sh"


@unittest.skipIf(os.name == "nt", "macOS LaunchAgent scripts require a POSIX shell")
class MacOSLaunchAgentTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory(prefix="kibitzer path & <xml> ")
        self.root = Path(self.tmpdir.name).resolve()
        scripts_dir = self.root / "scripts"
        python_dir = self.root / ".venv" / "bin"
        fake_bin = self.root / "fake-bin"
        self.home = self.root / "home"
        scripts_dir.mkdir()
        python_dir.mkdir(parents=True)
        fake_bin.mkdir()
        self.home.mkdir()

        self.installer = scripts_dir / INSTALL_SCRIPT.name
        self.uninstaller = scripts_dir / UNINSTALL_SCRIPT.name
        shutil.copy2(INSTALL_SCRIPT, self.installer)
        shutil.copy2(UNINSTALL_SCRIPT, self.uninstaller)
        (python_dir / "python").symlink_to(sys.executable)

        self.launchctl_log = self.root / "launchctl.log"
        launchctl = fake_bin / "launchctl"
        launchctl.write_text(
            """#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_LAUNCHCTL_LOG"
if [ "$1" = "bootout" ]; then
  status="${FAKE_BOOTOUT_STATUS:-0}"
  if [ "$status" -ne 0 ]; then
    printf 'simulated bootout failure: %s\n' "$status" >&2
  fi
  exit "$status"
fi
exit 0
""",
            encoding="utf-8",
        )
        launchctl.chmod(0o755)

        self.env = dict(os.environ)
        self.env["HOME"] = str(self.home)
        self.env["PATH"] = f"{fake_bin}{os.pathsep}{self.env.get('PATH', '')}"
        self.env["FAKE_LAUNCHCTL_LOG"] = str(self.launchctl_log)
        self.plist_path = (
            self.home / "Library" / "LaunchAgents" / "com.kibitzer.server.plist"
        )

    def tearDown(self) -> None:
        self.tmpdir.cleanup()

    def run_script(
        self,
        script: Path,
        *,
        bootout_status: int,
    ) -> subprocess.CompletedProcess[str]:
        env = dict(self.env)
        env["FAKE_BOOTOUT_STATUS"] = str(bootout_status)
        return subprocess.run(
            ["/bin/bash", str(script)],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )

    def seed_plist(self, contents: str = "diagnostic plist") -> None:
        self.plist_path.parent.mkdir(parents=True, exist_ok=True)
        self.plist_path.write_text(contents, encoding="utf-8")

    def launchctl_calls(self) -> list[str]:
        return self.launchctl_log.read_text(encoding="utf-8").splitlines()

    def test_installer_writes_parseable_plist_for_xml_metacharacter_path(self) -> None:
        for _ in range(2):
            result = self.run_script(self.installer, bootout_status=0)
            self.assertEqual(result.returncode, 0, result.stderr)

        with self.plist_path.open("rb") as plist_file:
            generated = plistlib.load(plist_file)

        log_dir = self.root / "data" / "logs"
        self.assertEqual(
            generated,
            {
                "Label": "com.kibitzer.server",
                "ProgramArguments": [
                    "/bin/bash",
                    str(self.root / "scripts" / "macos_run_server.sh"),
                ],
                "WorkingDirectory": str(self.root),
                "RunAtLoad": True,
                "KeepAlive": {"Crashed": True},
                "ProcessType": "Background",
                "EnvironmentVariables": {
                    "PATH": (
                        "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:"
                        "/usr/sbin:/sbin"
                    ),
                    "PYTHONUNBUFFERED": "1",
                },
                "StandardOutPath": str(log_dir / "macos-launch-agent.out.log"),
                "StandardErrorPath": str(log_dir / "macos-launch-agent.err.log"),
            },
        )

    def test_uninstaller_accepts_success_and_missing_service(self) -> None:
        for status in (0, 3):
            with self.subTest(bootout_status=status):
                self.seed_plist()
                result = self.run_script(self.uninstaller, bootout_status=status)

                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse(self.plist_path.exists())
                self.assertIn("Uninstalled com.kibitzer.server.", result.stdout)

    def test_uninstaller_preserves_plist_on_unexpected_bootout_failure(self) -> None:
        self.seed_plist()

        result = self.run_script(self.uninstaller, bootout_status=5)

        self.assertEqual(result.returncode, 5)
        self.assertEqual(
            self.plist_path.read_text(encoding="utf-8"),
            "diagnostic plist",
        )
        self.assertNotIn("Uninstalled", result.stdout)
        self.assertIn("simulated bootout failure: 5", result.stderr)

    def test_installer_accepts_missing_service_before_bootstrap(self) -> None:
        result = self.run_script(self.installer, bootout_status=3)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.plist_path.exists())
        self.assertEqual(
            self.launchctl_calls()[0],
            f"bootout gui/{os.getuid()}/com.kibitzer.server",
        )
        self.assertTrue(
            any(call.startswith("bootstrap ") for call in self.launchctl_calls())
        )

    def test_installer_stops_before_bootstrap_on_unexpected_bootout_failure(self) -> None:
        result = self.run_script(self.installer, bootout_status=5)

        self.assertEqual(result.returncode, 5)
        self.assertTrue(self.plist_path.exists())
        self.assertNotIn("Installed and started", result.stdout)
        self.assertEqual(
            self.launchctl_calls(),
            [f"bootout gui/{os.getuid()}/com.kibitzer.server"],
        )


if __name__ == "__main__":
    unittest.main()
