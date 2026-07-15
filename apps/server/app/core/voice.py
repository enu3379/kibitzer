from __future__ import annotations

import asyncio
import logging

_logged_missing_say = False
SAY_BINARY = "/usr/bin/say"


def speak(text: str, voice: str, rate: int) -> None:
    try:
        asyncio.create_task(_speak_once(text, voice, rate))
    except RuntimeError:
        logging.getLogger("kibitzer").debug("voice requested outside a running event loop")


async def _speak_once(text: str, voice: str, rate: int) -> None:
    global _logged_missing_say
    try:
        process = await asyncio.create_subprocess_exec(
            SAY_BINARY,
            "-v",
            voice,
            "-r",
            str(rate),
            "--",
            text,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await process.communicate()
    except FileNotFoundError:
        if not _logged_missing_say:
            logging.getLogger("kibitzer").warning("macOS say binary not found; voice delivery disabled")
            _logged_missing_say = True
    except Exception as exc:
        logging.getLogger("kibitzer").debug("voice delivery failed: %s", type(exc).__name__)
