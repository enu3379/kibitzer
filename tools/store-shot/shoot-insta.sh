#!/bin/zsh
# 인스타그램 캐러셀 4장을 docs/screenshots/ 로. prepare.sh 를 먼저 돌려야 한다.
set -e
D="${0:A:h}"
OUT="$D/../../docs/screenshots"

for n in 1 2 3 4; do
  case $n in
    1) f=insta-1-popup ;;
    2) f=insta-2-toast ;;
    3) f=insta-3-summary ;;
    4) f=insta-4-persona ;;
  esac
  "$D/shoot.sh" "file://$D/insta$n.html" "$OUT/$f.png" 1080 1080
done
