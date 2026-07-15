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


@unittest.skipIf(os.name == "nt", "macOS LaunchAgent scripts require a POSIX shell")
class MacOSLaunchAgentTest(unittest.TestCase):
    def test_installer_writes_parseable_plist_for_xml_metacharacter_path(self) -> None:
        with tempfile.TemporaryDirectory(prefix="kibitzer path & <xml> ") as tmpdir:
            root = Path(tmpdir).resolve()
            scripts_dir = root / "scripts"
            python_dir = root / ".venv" / "bin"
            fake_bin = root / "fake-bin"
            home = root / "home"
            scripts_dir.mkdir()
            python_dir.mkdir(parents=True)
            fake_bin.mkdir()
            home.mkdir()

            installer = scripts_dir / INSTALL_SCRIPT.name
            shutil.copy2(INSTALL_SCRIPT, installer)
            (python_dir / "python").symlink_to(sys.executable)

            launchctl = fake_bin / "launchctl"
            launchctl.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            launchctl.chmod(0o755)

            env = dict(os.environ)
            env["HOME"] = str(home)
            env["PATH"] = f"{fake_bin}{os.pathsep}{env.get('PATH', '')}"

            for _ in range(2):
                subprocess.run(
                    ["/bin/bash", str(installer)],
                    env=env,
                    capture_output=True,
                    text=True,
                    check=True,
                )

            plist_path = home / "Library" / "LaunchAgents" / "com.kibitzer.server.plist"
            with plist_path.open("rb") as plist_file:
                generated = plistlib.load(plist_file)

            log_dir = root / "data" / "logs"
            self.assertEqual(
                generated,
                {
                    "Label": "com.kibitzer.server",
                    "ProgramArguments": [
                        "/bin/bash",
                        str(root / "scripts" / "macos_run_server.sh"),
                    ],
                    "WorkingDirectory": str(root),
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


if __name__ == "__main__":
    unittest.main()
