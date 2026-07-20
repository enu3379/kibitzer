import csv
import os
import unittest
from collections import Counter, defaultdict
from pathlib import Path

from apps.server.app.core.normalization import strip_repeated_title_suffix
from apps.server.app.core.title_quality import classify_title


class ClassifyTitleUnitTest(unittest.TestCase):
    def test_empty_and_whitespace(self) -> None:
        self.assertEqual(classify_title(""), "empty")
        self.assertEqual(classify_title("   "), "empty")

    def test_url_like(self) -> None:
        self.assertEqual(classify_title("https://example.com/path"), "url_like")
        self.assertEqual(classify_title("www.naver.com"), "url_like")
        self.assertEqual(classify_title("example.com/a/b/c"), "url_like")
        self.assertEqual(classify_title("q=%EA%B2%80%EC%83%89"), "url_like")

    def test_generic_navigation_and_bare_platform(self) -> None:
        self.assertEqual(classify_title("로그인"), "generic")
        self.assertEqual(classify_title("Settings"), "generic")
        self.assertEqual(classify_title("YouTube"), "generic")
        self.assertEqual(classify_title("고객지원 | LG전자"), "generic")

    def test_content_specific_titles_pass_through(self) -> None:
        self.assertEqual(
            classify_title("Create - Minecraft Mods - CurseForge"), "content_specific"
        )
        self.assertEqual(
            classify_title("7월 제철 해산물 추천 - 나무위키"), "content_specific"
        )
        self.assertEqual(classify_title("Bruce Almighty - YouTube"), "content_specific")


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
