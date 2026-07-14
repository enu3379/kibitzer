from __future__ import annotations

import hashlib
import io
import tempfile
import unittest
from pathlib import Path

from scripts.download_embedding_model import ModelAsset, ensure_asset, verify_asset


class _Response(io.BytesIO):
    def __enter__(self) -> "_Response":
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


class EmbeddingModelDownloadTest(unittest.TestCase):
    def setUp(self) -> None:
        self.payload = b"small deterministic model fixture"
        self.asset = ModelAsset(
            relative_path="onnx/model.onnx",
            sha256=hashlib.sha256(self.payload).hexdigest(),
            size=len(self.payload),
        )

    def test_existing_verified_asset_skips_network(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            target = root / self.asset.relative_path
            target.parent.mkdir(parents=True)
            target.write_bytes(self.payload)

            def fail_open(url: str, timeout: float) -> _Response:
                raise AssertionError(f"unexpected network call: {url}, {timeout}")

            self.assertEqual(ensure_asset(self.asset, root, opener=fail_open), "verified")

    def test_download_is_verified_and_replaces_invalid_file(self) -> None:
        calls: list[tuple[str, float]] = []

        def fake_open(url: str, timeout: float) -> _Response:
            calls.append((url, timeout))
            return _Response(self.payload)

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            target = root / self.asset.relative_path
            target.parent.mkdir(parents=True)
            target.write_bytes(b"invalid")

            status = ensure_asset(self.asset, root, opener=fake_open)

            self.assertEqual(status, "downloaded")
            self.assertEqual(target.read_bytes(), self.payload)
            self.assertEqual(verify_asset(target, self.asset), (True, "ok"))
            self.assertEqual(len(calls), 1)
            self.assertFalse(target.with_name("model.onnx.part").exists())

    def test_invalid_download_fails_without_replacing_existing_file(self) -> None:
        def fake_open(url: str, timeout: float) -> _Response:
            return _Response(b"wrong")

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            target = root / self.asset.relative_path
            target.parent.mkdir(parents=True)
            target.write_bytes(b"keep me")

            with self.assertRaisesRegex(RuntimeError, "download verification failed"):
                ensure_asset(self.asset, root, attempts=1, opener=fake_open)

            self.assertEqual(target.read_bytes(), b"keep me")


if __name__ == "__main__":
    unittest.main()
