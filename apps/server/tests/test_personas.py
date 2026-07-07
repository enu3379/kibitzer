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


if __name__ == "__main__":
    unittest.main()
