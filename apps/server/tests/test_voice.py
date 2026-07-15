import asyncio
import unittest

import apps.server.app.core.voice as voice


class VoiceTest(unittest.TestCase):
    def test_speak_once_invokes_macos_say(self) -> None:
        calls = []
        original = voice.asyncio.create_subprocess_exec

        class FakeProcess:
            async def communicate(self) -> tuple[bytes, bytes]:
                return b"", b""

        async def fake_exec(*args, **kwargs):
            calls.append((args, kwargs))
            return FakeProcess()

        voice.asyncio.create_subprocess_exec = fake_exec
        try:
            asyncio.run(voice._speak_once("hello", "Yuna", 175))
        finally:
            voice.asyncio.create_subprocess_exec = original

        self.assertEqual(
            calls[0][0][:7],
            ("/usr/bin/say", "-v", "Yuna", "-r", "175", "--", "hello"),
        )


if __name__ == "__main__":
    unittest.main()
