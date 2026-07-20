import csv
import os
import unittest
from collections import Counter, defaultdict
from pathlib import Path

from apps.server.app.core.normalization import strip_repeated_title_suffix
from apps.server.app.core.title_quality import classify_title


class TitleQualityTest(unittest.TestCase):
    def test_step0_hand_labels_benchmark(self) -> None:
        corpus_root = os.environ.get("KIBITZER_AUDIT_CORPUS")
        if not corpus_root:
            self.skipTest("set KIBITZER_AUDIT_CORPUS to run the private corpus benchmark")
        paths = sorted(Path(corpus_root).glob("labeled-*.csv"))
        self.assertTrue(paths, f"expected Step-0 labeled CSVs under {corpus_root}")

        confusion: Counter[tuple[str, str]] = Counter()
        url_like_or_empty_as_content: list[tuple[str, str, str]] = []
        axis_total = 0
        axis_correct = 0

        for path in paths:
            previous_titles_by_host: dict[str, list[str]] = defaultdict(list)
            with path.open(newline="", encoding="utf-8") as handle:
                for row in csv.DictReader(handle):
                    host = row["url_host"]
                    stripped = strip_repeated_title_suffix(
                        (row["title"] or "").strip(),
                        previous_titles_by_host[host],
                    )
                    predicted = classify_title(stripped)
                    hand = row["title_quality"]
                    confusion[(hand, predicted)] += 1

                    if hand in {"content_specific", "generic"}:
                        axis_total += 1
                        if (hand == "content_specific") == (predicted == "content_specific"):
                            axis_correct += 1
                    if hand in {"url_like", "empty"} and predicted == "content_specific":
                        url_like_or_empty_as_content.append((path.name, row["title"], predicted))

                    previous_titles_by_host[host].insert(0, row["title"])

        print("title_quality confusion:", dict(sorted(confusion.items())))
        self.assertGreaterEqual(axis_correct / axis_total, 0.80)
        self.assertEqual(url_like_or_empty_as_content, [])


if __name__ == "__main__":
    unittest.main()
