# store-shot — Chrome Web Store 이미지 캡처 리그

`docs/screenshots/`의 스토어 자료(1280×800 스크린샷 5장, 프로모 타일 440×280, 마퀴 1400×560)를
헤드리스 Chrome으로 다시 뽑는 도구다. 장면은 전부 그냥 HTML이고, 실제 UI는 빌드 산출물을
`<iframe>`으로 박아서 보여준다 — 목업이 아니라 진짜 팝업·옵션 페이지가 찍힌다.

## 쓰는 법

```sh
cd apps/extension-next && npm run build   # dist/ 가 있어야 한다
cd ../../tools/store-shot
./prepare.sh        # dist/ 에서 popup·options·icons·폰트를 끌어오고 stub을 주입
./shoot-all.sh      # 7장 전부 docs/screenshots/ 로
```

한 장만:

```sh
./shoot.sh "file://$PWD/scene3.html" ../../docs/screenshots/store-3-summary.png 1280 800
```

## 구성

| 파일 | 내용 |
|---|---|
| `shoot.sh` | `<url> <out.png> <W> <H>`. 2배로 찍고 Pillow LANCZOS로 규격 픽셀에 맞춰 줄인다 |
| `prepare.sh` | `dist/`에서 `popup/` `options/` `icons/` `assets/fonts/`를 복사하고 모듈 번들 앞에 `stub.js`를 끼워 넣는다 |
| `shoot-all.sh` | 7장 일괄 렌더 |
| `scenes.css` | 2–5번 공통 캔버스·타이포. **브랜드 점 색 `--accent: #2b9e57`이 여기 있다** |
| `scene1.html` | 팝업 히어로. 유일하게 `scenes.css`를 안 쓰고 자체 타입 스케일을 갖는다 |
| `scene2.html` | 훈수 말풍선. 브라우저 창은 와이어프레임이고 말풍선만 진짜다 (`toast.js`) |
| `scene3.html` | 세션 종료 요약 (팝업 `?scene=summary`) |
| `scene4.html` `scene5.html` | 옵션 페이지 말투 탭 / AI 판정 탭 |
| `promo-tile.html` `promo-marquee.html` | 프로모 이미지. 인라인 SVG 한 덩어리 |
| `logo-compare.html` | 툴바 아이콘 · 옵션 헤더 로고 비교용 |
| `stub.js` | 서비스워커 없이 UI가 렌더되도록 만든 가짜 chrome API |
| `toast.js` | `dist/background.js`의 `showKibitzerToast`를 그대로 떼어 온 것 |

## 알아 둘 것

- **장면 상태는 `?scene=`으로 고른다.** `stub.js`가 그 값으로 고정 픽스처를 돌려준다 —
  `summary`면 종료 요약, 없으면 진행 중 세션, `persona`/`ai`는 옵션 탭. 목표 문구·게이지
  숫자·MVP/빌런을 바꾸려면 `stub.js`의 상수를 고치면 된다.
- **캡처 호스트가 다크 모드면 옵션 페이지가 통째로 어두워진다.** `stub.js`가 캐스케이드
  맨 끝에 라이트 토큰을 다시 선언해서 막고 있고, 말풍선은 `scene2.html`이 `matchMedia`를
  가로채서 라이트로 고정한다.
- **`shoot.sh`는 항상 2배로 찍는다.** 다만 지금 커밋돼 있는 `store-1-popup.png`만은 예외로
  2026-07-31에 1배로 찍힌 것이라, 다시 뽑으면 나머지처럼 또렷해지는 대신 지금 파일과
  픽셀이 달라진다.
- **`scene1.html`은 복원본이다.** 원본(`shot.html`)이 스크래치에만 있다가 사라져서
  세션 기록에서 되살렸다. 레이아웃은 커밋된 이미지와 일치하지만, `stub.js` 픽스처가
  그 뒤에 바뀌어서 팝업 안 목표 문구와 해시계 모양이 다르게 나온다.
- **커밋된 스토어 이미지는 게시 버전 v0.3.0 기준이다.** `prepare.sh`는 지금 체크아웃의
  빌드를 가져오므로, 게시 버전을 다시 찍으려면 그 태그에서 빌드해야 한다.
- 브랜드 점은 `#2b9e57` 하나로 통일돼 있다. `scene1.html`이 한동안 해시계 잎사귀색
  `#5aa63c`를 하드코딩하고 있었으니, 장면을 새로 만들 때 색을 직접 적지 말고
  `scenes.css`의 `--accent`를 쓸 것.
