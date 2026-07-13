#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import BinaryIO, Callable


ROOT = Path(__file__).resolve().parents[1]
MODEL_ROOT = ROOT / "data" / "models" / "koen-e5-tiny-onnx"
SOURCE_REPOSITORY = "exp-models/dragonkue-KoEn-E5-Tiny"
SOURCE_REVISION = "4c58635599cdecef58f19db20a776393a1dcc635"
SOURCE_BASE_URL = (
    f"https://huggingface.co/{SOURCE_REPOSITORY}/resolve/{SOURCE_REVISION}"
)
CHUNK_SIZE = 1024 * 1024


@dataclass(frozen=True)
class ModelAsset:
    relative_path: str
    sha256: str
    size: int

    @property
    def url(self) -> str:
        return f"{SOURCE_BASE_URL}/{self.relative_path}?download=true"


ASSETS = (
    ModelAsset(
        relative_path="onnx/model_qint8_arm64.onnx",
        sha256="d463c9b1c29f3202d510e2836265d60f9e6e6dd518c5930ba865700646489bd4",
        size=38_275_821,
    ),
    ModelAsset(
        relative_path="tokenizer.json",
        sha256="a6dd38d692ac1caa6d5dbc195d92f1f978b5c74ec60e02ed15fdf04404742fe3",
        size=2_931_715,
    ),
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(CHUNK_SIZE):
            digest.update(chunk)
    return digest.hexdigest()


def verify_asset(path: Path, asset: ModelAsset) -> tuple[bool, str]:
    if not path.is_file():
        return False, "missing"
    if path.stat().st_size != asset.size:
        return False, f"size {path.stat().st_size}, expected {asset.size}"
    actual = sha256_file(path)
    if actual != asset.sha256:
        return False, f"sha256 {actual}, expected {asset.sha256}"
    return True, "ok"


def _open_url(url: str, timeout: float) -> BinaryIO:
    request = urllib.request.Request(url, headers={"User-Agent": "kibitzer-model-setup/1"})
    return urllib.request.urlopen(request, timeout=timeout)  # type: ignore[return-value]


def ensure_asset(
    asset: ModelAsset,
    model_root: Path,
    *,
    timeout: float = 60.0,
    attempts: int = 3,
    opener: Callable[[str, float], BinaryIO] = _open_url,
) -> str:
    target = model_root / Path(asset.relative_path)
    valid, detail = verify_asset(target, asset)
    if valid:
        return "verified"

    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(f"{target.name}.part")
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            with opener(asset.url, timeout) as response, partial.open("wb") as output:
                while chunk := response.read(CHUNK_SIZE):
                    output.write(chunk)
            downloaded, download_detail = verify_asset(partial, asset)
            if not downloaded:
                raise RuntimeError(f"download verification failed: {download_detail}")
            os.replace(partial, target)
            return "downloaded"
        except Exception as exc:  # urllib raises several platform-specific error types
            last_error = exc
            partial.unlink(missing_ok=True)
            if attempt < attempts:
                time.sleep(attempt)

    raise RuntimeError(
        f"could not prepare {target} after {attempts} attempts "
        f"(existing file: {detail}): {last_error}"
    )


def write_manifest(model_root: Path) -> None:
    payload = {
        "source_repository": SOURCE_REPOSITORY,
        "source_revision": SOURCE_REVISION,
        "license": "Apache-2.0",
        "files": [asdict(asset) for asset in ASSETS],
    }
    (model_root / "model-manifest.json").write_text(
        json.dumps(payload, indent=2) + "\n",
        encoding="ascii",
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download and verify Kibitzer's local KoEn E5 Tiny ONNX assets"
    )
    parser.add_argument("--check", action="store_true", help="verify local files without downloading")
    parser.add_argument("--model-root", type=Path, default=MODEL_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.check:
        failed = False
        for asset in ASSETS:
            target = args.model_root / Path(asset.relative_path)
            valid, detail = verify_asset(target, asset)
            print(f"{'OK' if valid else 'MISSING'} {target}: {detail}")
            failed = failed or not valid
        return 1 if failed else 0

    for asset in ASSETS:
        status = ensure_asset(asset, args.model_root)
        print(f"{status}: {args.model_root / Path(asset.relative_path)}")
    write_manifest(args.model_root)
    print("Embedding model setup complete.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
