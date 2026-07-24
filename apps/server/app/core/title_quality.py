from __future__ import annotations

import re
from typing import Literal

TitleQuality = Literal["content_specific", "generic", "url_like", "empty"]

LOW_QUALITY_TITLES = {"generic", "url_like", "empty"}

_URL_SCHEME_RE = re.compile(r"^[a-z][a-z0-9+.-]*://", re.IGNORECASE)
_DOTTED_HOST_RE = re.compile(r"^[a-z0-9-]+(?:\.[a-z0-9-]+){1,}(?:/[^\s]*)?$", re.IGNORECASE)
_PERCENT_ESCAPE_RE = re.compile(r"%[0-9a-f]{2}", re.IGNORECASE)
_LETTER_OR_DIGIT_RE = re.compile(r"[A-Za-z0-9가-힣]")
_HANGUL_RE = re.compile(r"[가-힣]")

_TITLE_SEPARATORS = (" - ", " | ", " · ", " :: ", " – ", " — ", " • ", " : ")

_GENERIC_EXACT = {
    "instagram",
    "(1) instagram",
    "instagram 메시지",
    "instagram • 메시지",
    "youtube",
    "naver",
    "reddit - 인터넷의 맥박",
    "치지직 - chzzk",
    "chzzk",
    "연합뉴스tv",
    "네이버+ 스토어",
    "네이버 스토어",
    "오늘끝딜 : 네이버+ 스토어",
    "고객지원 | lg전자",
    "베스트샵 | lg전자",
    "lg전자 서비스",
    "lg ai | lg전자",
    "lg ai",
    "삼성공식파트너 문성전자",
    "usage · settings",
    "ollama keys · settings",
    "settings",
    "npay 증권",
}

_GENERIC_TOKENS = {
    "home",
    "login",
    "sign",
    "settings",
    "usage",
    "keys",
    "customer",
    "support",
    "help",
    "search",
    "results",
    "youtube",
    "instagram",
    "naver",
    "google",
    "reddit",
    "ollama",
    "lg",
    "lg전자",
    "ai",
    "로그인",
    "홈",
    "설정",
    "고객지원",
    "고객",
    "지원",
    "서비스",
    "베스트샵",
    "검색",
    "검색결과",
    "결과",
    "메시지",
    "스토어",
    "뉴스",
    "스포츠",
    "증권",
    "나무위키",
    "커뮤니티",
    "포털",
    "디시인사이드",
}


def classify_title(text: str) -> TitleQuality:
    title = " ".join((text or "").strip().split())
    if not title:
        return "empty"

    lowered = title.casefold()
    if _looks_url_like(title):
        return "url_like"
    if _looks_generic(title, lowered):
        return "generic"
    return "content_specific"


def is_low_quality_title(quality: str | None) -> bool:
    return quality in LOW_QUALITY_TITLES


def _looks_url_like(title: str) -> bool:
    lowered = title.casefold()
    if _URL_SCHEME_RE.match(title) or lowered.startswith("www."):
        return True
    if _PERCENT_ESCAPE_RE.search(title):
        return True
    if title.count("/") >= 2:
        return True
    if "=" in title:
        return True
    if "/" in title and "." in title.split("/", 1)[0] and " " not in title:
        return True
    if _DOTTED_HOST_RE.match(title) and not _HANGUL_RE.search(title):
        return True

    alnum = sum(1 for ch in title if ch.isalnum())
    punctuation = sum(1 for ch in title if not ch.isalnum() and not ch.isspace())
    return len(title) >= 12 and punctuation > alnum


def _looks_generic(title: str, lowered: str) -> bool:
    compact = _compact_for_exact(lowered)
    if compact in _GENERIC_EXACT:
        return True
    if not _LETTER_OR_DIGIT_RE.search(title):
        return True
    if _is_dc_gallery_landing(title):
        return True
    if _is_naver_section_landing(title):
        return True

    content = _content_tokens(title)
    if not content:
        return True

    # Short all-brand/navigation titles are furniture; short named works such as
    # "Bruce Almighty - YouTube" keep their content tokens and pass through.
    if len(content) == 1 and _brandish_single_token(content[0]):
        return True
    return False


def _compact_for_exact(lowered: str) -> str:
    return re.sub(r"\s+", " ", lowered).strip()


def _is_dc_gallery_landing(title: str) -> bool:
    return bool(
        re.match(
            r"^[^-]+ (?:마이너|미니) 갤러리(?: - 커뮤니티 포털 디시인사이드)?$",
            title,
        )
    )


def _is_naver_section_landing(title: str) -> bool:
    return bool(
        re.match(
            r"^(?:사회|세계|IT/과학|아웃도어)\s*:\s*네이버(?:\s*뉴스|스포츠)$",
            title,
            re.IGNORECASE,
        )
    )


def _content_tokens(title: str) -> list[str]:
    tokens: list[str] = []
    for segment in _split_segments(title):
        for token in re.findall(r"[A-Za-z0-9가-힣+&/]+", segment):
            lowered = token.casefold()
            if lowered in _GENERIC_TOKENS:
                continue
            if lowered.isdigit():
                continue
            tokens.append(lowered)
    return tokens


def _split_segments(title: str) -> list[str]:
    segments = [title]
    for separator in _TITLE_SEPARATORS:
        next_segments: list[str] = []
        for segment in segments:
            next_segments.extend(segment.split(separator))
        segments = next_segments
    return [segment.strip() for segment in segments if segment.strip()]


def _brandish_single_token(token: str) -> bool:
    if token in {"오늘끝딜", "연합뉴스tv", "삼성공식파트너", "문성전자"}:
        return True
    if re.fullmatch(r"[가-힣]{1,4}", token):
        return True
    if re.fullmatch(r"[a-z]+", token) and len(token) <= 6:
        return True
    return False
