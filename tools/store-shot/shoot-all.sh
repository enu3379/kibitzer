#!/bin/zsh
# Renders the whole store kit into docs/screenshots/. Run prepare.sh first.
set -e
D="${0:A:h}"
OUT="$D/../../docs/screenshots"

for n in 1 2 3 4 5; do
  case $n in
    1) f=store-1-popup ;;
    2) f=store-2-toast ;;
    3) f=store-3-summary ;;
    4) f=store-4-persona ;;
    5) f=store-5-ai ;;
  esac
  "$D/shoot.sh" "file://$D/scene$n.html" "$OUT/$f.png" 1280 800
done

"$D/shoot.sh" "file://$D/promo-tile.html"    "$OUT/promo-tile-440x280.png"    440 280
"$D/shoot.sh" "file://$D/promo-marquee.html" "$OUT/promo-marquee-1400x560.png" 1400 560
