from __future__ import annotations


def clamp_notification_message(message: str, max_sentences: int) -> str:
    text = " ".join(message.split())
    if max_sentences <= 0:
        return text

    sentences: list[str] = []
    start = 0
    for index, char in enumerate(text):
        if char in ".!?。！？":
            sentence = text[start : index + 1].strip()
            if sentence:
                sentences.append(sentence)
            start = index + 1
            if len(sentences) >= max_sentences:
                return " ".join(sentences)

    tail = text[start:].strip()
    if tail and len(sentences) < max_sentences:
        sentences.append(tail)
    return " ".join(sentences)
