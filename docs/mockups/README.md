# docs/mockups

배포되지 않는 디자인 산출물. 브라우저에서 파일을 직접 열면 동작하고, 확장 빌드에는 포함되지 않는다.

| 파일 | 용도 |
|---|---|
| [persona-sample-line.html](persona-sample-line.html) | 설정 › 말투 탭에 대표 문장을 어떻게 표출할지 비교한 레이아웃 시안 4종(A~D). D안이 채택돼 `options.html`에 구현됐다. |
| [persona-copy-picker.html](persona-copy-picker.html) | 페르소나별 문장 후보를 실제 인용 스트립 모양으로 놓고 하나씩 고르는 도구. 선택은 브라우저 localStorage에만 남고, 하단에서 `personaSampleLines.ts`에 붙여넣을 코드가 나온다. |

문장 후보 도구는 코드와 연결돼 있지 않다 — 고른 결과를 [personaSampleLines.ts](../../apps/extension/src/lib/personaSampleLines.ts)에 손으로 옮겨야 반영된다.
