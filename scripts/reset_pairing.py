from __future__ import annotations

import socket
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
AUTH_FILES = (ROOT / "data" / "auth.key", ROOT / "data" / "pairing.code")


def main() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as client:
        client.settimeout(0.25)
        if client.connect_ex(("127.0.0.1", 8765)) == 0:
            print("Kibitzer 서버를 먼저 중지한 뒤 다시 실행하세요.")
            return 1

    removed = False
    for path in AUTH_FILES:
        if path.is_file():
            path.unlink()
            removed = True
    if removed:
        print(
            "페어링을 초기화했습니다. 서버를 다시 시작하고 "
            "확장 프로그램에 새 코드를 입력하세요."
        )
    else:
        print("저장된 페어링이 없습니다. 서버를 시작하면 새 코드가 생성됩니다.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
