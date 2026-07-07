import tempfile
import unittest
from pathlib import Path

import yaml

from apps.server.app.core.personas import compose_tier2_system_prompt, load_personas


class PersonaTest(unittest.TestCase):
    def test_load_personas_ignores_unknown_keys_and_composes_prompt(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "personas.yaml"
            path.write_text(
                yaml.safe_dump(
                    {
                        "version": 1,
                        "default": "test",
                        "unknown": "ignored",
                        "personas": {
                            "test": {
                                "name": "Test",
                                "style_prompt": "Use a concise style.",
                                "fallback_templates": ["Back to {goal}."],
                                "unexpected": "ignored",
                            }
                        },
                    }
                )
            )

            persona_set = load_personas(path)

        self.assertEqual(persona_set.default, "test")
        self.assertIn("test", persona_set.personas)
        prompt = compose_tier2_system_prompt(persona_set.personas["test"])
        self.assertIn("Return strict JSON only", prompt)
        self.assertIn('"confirm_drift":true|false', prompt)
        self.assertIn("Use a concise style.", prompt)

    def test_load_personas_merges_user_file_and_skips_invalid_entries(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base_path = Path(tmp) / "personas.yaml"
            user_path = Path(tmp) / "user-personas.yaml"
            base_path.write_text(
                yaml.safe_dump(
                    {
                        "version": 1,
                        "default": "base",
                        "personas": {
                            "base": {"name": "Base", "style_prompt": "Base style."},
                            "shared": {"name": "Base Shared", "style_prompt": "Old."},
                        },
                    }
                )
            )
            user_path.write_text(
                yaml.safe_dump(
                    {
                        "default": "custom",
                        "personas": {
                            "shared": {"name": "User Shared", "style_prompt": "New."},
                            "custom": {"name": "Custom", "celebrate_templates": ["Back to {goal}."]},
                            "broken": {"name": "Broken", "celebrate_templates": "not-a-list"},
                        },
                    }
                )
            )

            persona_set = load_personas(base_path, user_path=user_path)

        self.assertEqual(persona_set.default, "custom")
        self.assertEqual(persona_set.personas["shared"].name, "User Shared")
        self.assertIn("base", persona_set.personas)
        self.assertIn("custom", persona_set.personas)
        self.assertNotIn("broken", persona_set.personas)


if __name__ == "__main__":
    unittest.main()
