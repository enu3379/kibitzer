from __future__ import annotations

import hashlib
import uuid
from urllib.parse import urlparse

from ..schemas import Observation, RawObservation, Source


def normalize_browser_nav(raw: RawObservation, session_id: str) -> Observation:
    url = str(raw.payload.url)
    parsed = urlparse(url)
    location = parsed.path or "/"
    if parsed.query:
        location += f"?{parsed.query}"
    if parsed.fragment:
        location += f"#{parsed.fragment}"
    payload = {
        "url_host": parsed.hostname or "",
        # The extension computes this identity before removing raw query and
        # fragment data from the URL sent to localhost. Direct API callers fall
        # back to hashing the received location for compatibility.
        "url_path_hash": raw.payload.url_path_hash or _hash_location(location),
        "title": raw.payload.title.strip(),
        "tab_id": raw.payload.tab_id,
    }
    return Observation(
        id=f"obs_{uuid.uuid4().hex}",
        ts=raw.ts,
        session_id=session_id,
        source=Source.BROWSER_NAV,
        payload=payload,
    )


def browser_nav_embedding_text(observation: Observation) -> str:
    # Title only. Host tokens once polluted the OK anchor: with a low tau_ok, any
    # page on a previously-OK host matched through shared host tokens alone,
    # effectively whitelisting the whole domain.
    return str(observation.payload.get("title") or "").strip()


# Rightmost-match separators for the near-universal SEO title template
# "<page> <sep> <site name>". Space-padded so hyphenated words survive.
_TITLE_SUFFIX_SEPARATORS = (" - ", " | ", " · ", " :: ", " – ", " — ")
_SUFFIX_REPEATS_REQUIRED = 2


def strip_repeated_title_suffix(title: str, previous_titles: list[str]) -> str:
    """Drop a trailing "<sep> <site name>" segment the host repeats on every page.

    Site-name furniture ("- 나무위키", "| LG전자") dominates bigram similarity for
    short Korean titles: one furniture-carrying page admitted into the OK anchor
    whitelists the whole platform. The suffix is only dropped when the same
    trailing segment ends enough *previous* titles from the same host, so
    legitimate one-off segments survive.
    """
    stripped = title.strip()
    cut = -1
    for separator in _TITLE_SUFFIX_SEPARATORS:
        cut = max(cut, stripped.rfind(separator))
    if cut <= 0:
        return stripped
    suffix = stripped[cut:]
    core = stripped[:cut].strip()
    if len(core) < 2:
        return stripped
    repeats = sum(1 for previous in previous_titles if previous and previous.strip().endswith(suffix))
    return core if repeats >= _SUFFIX_REPEATS_REQUIRED else stripped


def _hash_location(location: str) -> str:
    return hashlib.sha256(location.encode("utf-8")).hexdigest()
