from __future__ import annotations

import json
import unittest

import httpx

from apps.server.app.providers.judges.http_utils import read_bounded_json_object


class JudgeResponseLimitTest(unittest.IsolatedAsyncioTestCase):
    async def test_reads_a_bounded_json_object(self) -> None:
        response = httpx.Response(200, content=json.dumps({"ok": True}).encode("utf-8"))

        self.assertEqual(await read_bounded_json_object(response, max_bytes=100), {"ok": True})

    async def test_rejects_oversized_or_non_object_responses(self) -> None:
        oversized = httpx.Response(200, content=b"x" * 101)
        non_object = httpx.Response(200, content=b"[]")

        with self.assertRaisesRegex(ValueError, "size limit"):
            await read_bounded_json_object(oversized, max_bytes=100)
        with self.assertRaisesRegex(ValueError, "JSON object"):
            await read_bounded_json_object(non_object, max_bytes=100)


if __name__ == "__main__":
    unittest.main()
