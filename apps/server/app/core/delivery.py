from __future__ import annotations

_BOUNDARIES = ".!?。！？"
# A boundary char only ends a sentence when followed by whitespace, a closing
# quote/bracket, or end-of-text. This keeps dots inside domains ("youtube.com")
# and numbers ("3.6") from splitting a sentence, and counts stacked marks
# ("세이프!!") as a single boundary instead of a bare-"!" sentence.
_AFTER_BOUNDARY = " \t\"'”’»」』)]"


def clamp_notification_message(message: str, max_sentences: int) -> str:
    text = " ".join(message.split())
    if max_sentences <= 0:
        return text

    sentences: list[str] = []
    start = 0
    index = 0
    length = len(text)
    while index < length:
        if text[index] in _BOUNDARIES:
            end = index
            while end + 1 < length and text[end + 1] in _BOUNDARIES:
                end += 1
            next_char = text[end + 1] if end + 1 < length else ""
            if next_char == "" or next_char in _AFTER_BOUNDARY:
                sentence = text[start : end + 1].strip()
                if sentence:
                    sentences.append(sentence)
                start = end + 1
                if len(sentences) >= max_sentences:
                    return " ".join(sentences)
            index = end + 1
            continue
        index += 1

    tail = text[start:].strip()
    if tail and len(sentences) < max_sentences:
        sentences.append(tail)
    return " ".join(sentences)
