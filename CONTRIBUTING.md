# Contributing — Kibitzer

협업 규칙의 단일 출처(single source of truth). 사람과 AI 에이전트 모두 이 문서를 따른다.
(코딩 에이전트용 운영 요약은 [AGENTS.md](AGENTS.md), 전략 결정 로그는 [docs/planning-notes.md](docs/planning-notes.md))

## 브랜치 전략

| 브랜치 | 역할 | 규칙 |
|---|---|---|
| `main` | 안정 스냅샷 | `dev`와 `hotfix/*`의 PR만 받음 (merge commit) |
| `dev` | 통합 (기본 브랜치) | 모든 작업 브랜치의 PR 대상. squash 머지만 |
| `feature/<슬러그>` | 기능 (이슈가 있으면 `feature/<이슈#>-<슬러그>`) | `dev`에서 분기 |
| `fix/<슬러그>` | 버그 수정 | `dev`에서 분기 |
| `chore/<슬러그>` | 문서·리팩토링·설정 | `dev`에서 분기 |
| `codex/<슬러그>` | Codex 에이전트 작업 | `dev`에서 분기, 나머지는 feature/fix와 동일 |
| `hotfix/<슬러그>` | 긴급 수정 | **`main`에서 분기**, main과 dev **양쪽에** 머지 |

- 작업 브랜치는 머지되면 자동 삭제된다. 짧게 유지할 것.
- `main`·`dev`는 룰셋이 보호한다: 직접 push·force-push·삭제 불가, CI 통과 필수, 머지 방식도 강제됨(dev는 squash만, main은 merge commit만 버튼이 뜬다).

## 작업 흐름

1. **작업 지시서에서 시작** — 배경과 수용 기준을 이슈(또는 `docs/handoff-*.md`)에 적는다. 사람이든 에이전트든 그 문서만 보고 착수할 수 있어야 한다.
2. `dev`에서 브랜치를 딴다.
3. PR을 `dev`로 연다. 제목은 Conventional Commits 형식, 관련 이슈가 있으면 본문에 `Closes #이슈번호`.
4. CI(macOS·Windows: 서버 pytest + 확장 빌드) 통과 후 squash 머지한다. 리뷰 승인은 머지 조건이 아니지만, CODEOWNERS가 상대에게 리뷰 요청을 자동으로 보낸다.

## PR 제목 = 커밋 컨벤션

squash 머지 시 **PR 제목이 dev의 커밋 메시지가 된다.** 개별 커밋은 자유롭게 하되 PR 제목만 지키면 된다:

| 타입 | 용도 |
|---|---|
| `feat:` | 기능 추가·변경 |
| `fix:` | 버그 수정 |
| `refactor:` | 동작 변화 없는 구조 개선 |
| `docs:` | 문서 |
| `test:` | 테스트 |
| `chore:` | 빌드·설정·기타 |

예: `feat: make browser dwell gates configurable`

PR은 작게 — 하나의 PR은 하나의 주제만 다룬다.

## main 승격

1. `dev` → `main` PR을 연다 (merge commit — 승격 경계가 히스토리에 남는다).
2. 미루지 말고 안정 단위로 자주 승격할 것. dev가 오래 묵으면 main이 무의미해진다.
3. 배포 산출물(패키징)이 생기면 그때 버전 태그·릴리스 파이프라인을 도입한다.

## 복구 원칙

- 잘못 머지됐으면 **revert**: `git revert -m 1 <머지커밋>`. 히스토리는 지우지 않고 앞으로만 쌓는다.
- 특정 시점을 남기고 싶으면 브랜치가 아니라 **태그**.
- force-push 차단이 곧 복구 가능성의 보장이다. 한번 머지된 상태는 언제든 되돌아갈 수 있다.

## AI 협업

- 에이전트(Claude Code, Codex 등)도 이 문서의 규칙을 그대로 따른다.
- 전략 결정은 [docs/planning-notes.md](docs/planning-notes.md)에 D-번호(D1, D2, …)로 기록하고, 에이전트에게 넘기는 기계적 작업은 `docs/handoff-*.md`로 작성한다.
- AI가 작성·보조한 PR은 템플릿의 **AI-assisted** 체크박스를 켠다 — 리뷰어가 리뷰 강도를 판단하는 신호.
- 시크릿은 절대 커밋하지 않는다: `.env`, `configs/models.local.yaml`은 로컬 전용이고 git이 무시한다. CI에 필요한 값은 GitHub Secrets에 넣는다.
