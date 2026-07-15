import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from apps.server.tests.support import TestClient

from apps.server.app.config import AppConfig, ServerConfig, Tier1Config, Tier2Config
from apps.server.app.main import create_app
from apps.server.app.ports import (
    PORT_CANDIDATES,
    PROTOCOL_VERSION,
    SERVICE_NAME,
    PortSelectionError,
    acquire_server_socket,
    clear_effective_port,
    is_kibitzer_identity,
    main as serve_main,
    write_effective_port,
)
from apps.server.app.runtime_paths import RuntimePaths
from apps.server.app.storage.sqlite import SQLiteStore
from apps.server.app.version import APP_VERSION


class FakeSocket:
    def __init__(self, occupied: set[int]) -> None:
        self.occupied = occupied
        self.bound_port: int | None = None
        self.closed = False

    def bind(self, address: tuple[str, int]) -> None:
        port = address[1]
        if port in self.occupied:
            raise OSError("address already in use")
        self.bound_port = port

    def listen(self, backlog: int) -> None:
        assert backlog > 0

    def close(self) -> None:
        self.closed = True


class PortSelectionTest(unittest.TestCase):
    def test_confirmed_candidate_order(self) -> None:
        self.assertEqual(PORT_CANDIDATES, (49187, 51387, 53587, 55787, 57987))

    def test_first_candidate_is_bound_when_available(self) -> None:
        candidate = FakeSocket(set())
        port, selected = acquire_server_socket(
            ports=PORT_CANDIDATES[:2],
            probe=lambda _port: False,
            socket_factory=lambda: candidate,  # type: ignore[arg-type]
        )

        self.assertEqual(port, 49187)
        self.assertIs(selected, candidate)

    def test_first_collision_keeps_second_socket_bound(self) -> None:
        sockets: list[FakeSocket] = []

        def socket_factory() -> FakeSocket:
            candidate = FakeSocket({49187})
            sockets.append(candidate)
            return candidate

        port, selected = acquire_server_socket(
            ports=PORT_CANDIDATES[:2],
            probe=lambda _port: False,
            socket_factory=socket_factory,  # type: ignore[arg-type]
        )

        self.assertEqual(port, 51387)
        self.assertIs(selected, sockets[1])
        self.assertTrue(sockets[0].closed)
        self.assertFalse(sockets[1].closed)

    def test_all_candidates_occupied_fails_with_attempted_ports(self) -> None:
        with self.assertRaisesRegex(PortSelectionError, "49187, 51387"):
            acquire_server_socket(
                ports=PORT_CANDIDATES[:2],
                probe=lambda _port: False,
                socket_factory=lambda: FakeSocket(set(PORT_CANDIDATES)),  # type: ignore[arg-type]
            )

    def test_existing_kibitzer_skips_binding(self) -> None:
        port, selected = acquire_server_socket(
            ports=PORT_CANDIDATES[:2],
            probe=lambda candidate: candidate == 51387,
            socket_factory=lambda: self.fail("must not bind when Kibitzer is running"),
        )

        self.assertEqual(port, 51387)
        self.assertIsNone(selected)

    def test_unrelated_identity_is_rejected(self) -> None:
        self.assertFalse(
            is_kibitzer_identity(
                {"service": "other", "protocol_version": PROTOCOL_VERSION, "instance_id": "x"}
            )
        )
        self.assertFalse(
            is_kibitzer_identity(
                {"service": SERVICE_NAME, "protocol_version": 99, "instance_id": "x"}
            )
        )

    def test_effective_port_file_is_atomic_and_owner_scoped(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "profile" / "kibitzer.port"
            write_effective_port(49187, path)
            self.assertEqual(path.read_text(encoding="utf-8"), "49187\n")

            clear_effective_port(51387, path)
            self.assertTrue(path.exists())
            clear_effective_port(49187, path)
            self.assertFalse(path.exists())

    def test_server_entrypoint_writes_port_to_runtime_data_dir(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            paths = RuntimePaths(
                mode="packaged",
                resource_root=root / "bundle",
                data_dir=root / "profile",
                user_config_dir=root / "profile" / "configs",
                default_config_file=root / "bundle" / "configs" / "default.yaml",
                env_file=root / "profile" / ".env",
                custom_personas_file=root / "profile" / "configs" / "personas.yaml",
            )
            with patch(
                "apps.server.app.ports.acquire_server_socket",
                return_value=(49187, None),
            ):
                self.assertEqual(serve_main(paths), 0)

            self.assertEqual(paths.effective_port_file.read_text(encoding="utf-8"), "49187\n")


class IdentityEndpointTest(unittest.TestCase):
    def test_identity_is_versioned_and_instance_scoped(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "kibitzer.sqlite3"
            config = AppConfig(
                server=ServerConfig(db_path=str(db_path)),
                tier1=Tier1Config(enabled=False),
                tier2=Tier2Config(enabled=False),
            )
            with TestClient(create_app(config=config, store=SQLiteStore(db_path))) as client:
                identity = client.get("/identity").json()
                health = client.get("/health").json()

        self.assertEqual(identity["service"], SERVICE_NAME)
        self.assertEqual(identity["protocol_version"], PROTOCOL_VERSION)
        self.assertTrue(identity["instance_id"])
        self.assertEqual(health["version"], APP_VERSION)


if __name__ == "__main__":
    unittest.main()
