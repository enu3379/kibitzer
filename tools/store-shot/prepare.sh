#!/bin/zsh
# Populates this directory with the pieces of the extension build that the scenes embed:
# the popup and options pages, the toolbar icons and the bundled face. Everything it writes
# is gitignored — rerun it after any `npm run build`.
set -e
D="${0:A:h}"
DIST="$D/../../apps/extension-next/dist"

if [ ! -d "$DIST/popup" ]; then
  echo "no build at $DIST — run 'npm run build' in apps/extension-next first" >&2
  exit 1
fi

rm -rf "$D/popup" "$D/options" "$D/icons" "$D/assets"
mkdir -p "$D/assets"
cp -R "$DIST/popup" "$DIST/options" "$DIST/icons" "$D/"
cp -R "$DIST/assets/fonts" "$D/assets/"   # models/ and ort/ are ~88MB and unused here

# The scenes load the shipped bundles straight off file://, with no service worker behind
# them, so stub.js has to install its fake chrome API before the module bundle runs.
python3 - "$D" <<'PY'
import pathlib, sys

root = pathlib.Path(sys.argv[1])
for name in ("popup", "options"):
    page = root / name / f"{name}.html"
    html = page.read_text(encoding="utf-8")
    tag = f'<script type="module" src="{name}.js"></script>'
    if tag not in html:
        raise SystemExit(f"{page}: could not find {tag} to inject the stub before")
    page.write_text(html.replace(tag, f'<script src="../stub.js"></script>\n    {tag}'), encoding="utf-8")
    print(f"stubbed {name}/{name}.html")
PY
