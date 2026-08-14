#!/bin/zsh
# shoot.sh <url> <out.png> <width> <height>
# Captures at 4x device scale, then downscales to the exact requested pixel size — the extra
# resolution heading into Lanczos downscale reads noticeably crisper than capturing at 2x
# directly (compared side by side; see docs/screenshots/*@2x.png vs *@4x.png while they last).
set -e
D="${0:A:h}"
URL="$1"; OUT="$2"; W="$3"; H="$4"
TMP="$D/.raw-$(basename "$OUT")"
CHROME_BIN="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
if [[ ! -x "$CHROME_BIN" ]]; then
  echo "Chrome executable not found: $CHROME_BIN" >&2
  exit 1
fi
"$CHROME_BIN" \
  --headless=new --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=4 --window-size="$W,$H" \
  --virtual-time-budget=4000 --allow-file-access-from-files \
  --screenshot="$TMP" "$URL" >/dev/null 2>&1
python3 - "$TMP" "$OUT" "$W" "$H" <<'PY'
import sys
from PIL import Image
src, dst, w, h = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
im = Image.open(src).convert("RGB")
if im.size != (w, h):
    im = im.resize((w, h), Image.LANCZOS)
im.save(dst)
print(f"{dst} {im.size[0]}x{im.size[1]}")
PY
rm -f "$TMP"
