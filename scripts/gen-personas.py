"""Vendor configs/personas/*.yaml into a TS module, verbatim (no hand-copying)."""
import glob
import json
import os
import sys

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PERSONA_DIR = os.path.join(ROOT, "configs/personas")
INDEX = os.path.join(ROOT, "configs/personas.yaml")
OUT = os.path.join(ROOT, "apps/extension-next/src/lib/personas.data.ts")

index = yaml.safe_load(open(INDEX, encoding="utf-8")) or {}
default = index.get("default", "dry_kibitzer")

order = []
personas = {}
for path in sorted(glob.glob(os.path.join(PERSONA_DIR, "*.yaml"))):
    data = yaml.safe_load(open(path, encoding="utf-8")) or {}
    for key, val in data.items():
        if key in personas:
            sys.exit(f"duplicate persona key {key} in {path}")
        order.append(key)
        entry = {
            "name": val.get("name", ""),
            "stylePrompt": (val.get("style_prompt") or "").rstrip("\n"),
            "fallbackTemplates": list(val.get("fallback_templates") or []),
            "celebrateTemplates": list(val.get("celebrate_templates") or []),
        }
        if val.get("max_sentences") is not None:
            entry["maxSentences"] = int(val["max_sentences"])
        personas[key] = entry

if default not in personas:
    sys.exit(f"default persona {default!r} not found among {order}")


def js(value):
    # JSON is valid TS and escapes every string faithfully.
    return json.dumps(value, ensure_ascii=False)


lines = []
lines.append("// AUTO-GENERATED from configs/personas.yaml + configs/personas/*.yaml.")
lines.append("// Do not edit by hand — regenerate with scripts/gen-personas (verbatim port).")
lines.append("// The 10 personas are STYLE layers for the Tier-2 Message Writer (judge/writer split).")
lines.append("")
lines.append("export interface PersonaData {")
lines.append("  name: string")
lines.append("  stylePrompt: string")
lines.append("  fallbackTemplates: string[]")
lines.append("  celebrateTemplates: string[]")
lines.append("  maxSentences?: number")
lines.append("}")
lines.append("")
lines.append(f"export const PERSONA_DEFAULT = {js(default)}")
lines.append("")
lines.append(f"export const PERSONA_ORDER: readonly string[] = {js(order)}")
lines.append("")
lines.append("export const PERSONAS: Record<string, PersonaData> = {")
for key in order:
    p = personas[key]
    lines.append(f"  {js(key)}: {{")
    lines.append(f"    name: {js(p['name'])},")
    lines.append(f"    stylePrompt: {js(p['stylePrompt'])},")
    lines.append(f"    fallbackTemplates: {js(p['fallbackTemplates'])},")
    lines.append(f"    celebrateTemplates: {js(p['celebrateTemplates'])},")
    if "maxSentences" in p:
        lines.append(f"    maxSentences: {p['maxSentences']},")
    lines.append("  },")
lines.append("}")
lines.append("")

open(OUT, "w", encoding="utf-8").write("\n".join(lines))
print(f"wrote {OUT}")
print(f"default={default}  personas={len(order)}  order={order}")
for key in order:
    p = personas[key]
    print(f"  {key:16} name={p['name']!r:20} fb={len(p['fallbackTemplates'])} celeb={len(p['celebrateTemplates'])} max={p.get('maxSentences','-')}")
