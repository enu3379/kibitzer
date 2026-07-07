from collections import deque


class AnchorWindow:
    def __init__(self, maxlen: int) -> None:
        self._items: deque[list[float]] = deque(maxlen=maxlen)

    def add_ok(self, emb: list[float]) -> None:
        self._items.append(emb)

    def value(self) -> list[float] | None:
        if not self._items:
            return None
        width = len(self._items[0])
        sums = [0.0] * width
        for emb in self._items:
            for i, value in enumerate(emb):
                sums[i] += value
        return [value / len(self._items) for value in sums]

