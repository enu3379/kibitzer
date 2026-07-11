# Worktree Workflow

이 문서는 정본 checkout을 `dev`에 유지하면서 여러 작업 브랜치를 sibling
worktree로 분리해 사람과 AI agent가 병렬 작업하는 절차를 정의합니다.

## 기본 원칙

- Git worktree 사용을 권장합니다.
- 정본 checkout은 `dev` 동기화, worktree 생성·조회·제거, 설치된 로그인 시작
  서비스 운영에만 사용합니다.
- 실제 파일 변경은 `kibitzer-A`, `kibitzer-B` 같은 별도 worktree에서 합니다.
- worktree 하나에는 작업 브랜치 하나와 활성 agent 세션 하나만 둡니다.
- `.venv`, `node_modules`, `dist`, `data`, `.env`, 로컬 모델 설정은 worktree별로
  격리합니다.

현재 Windows 정본 경로는 다음과 같습니다.

```text
C:\Users\kimde\Desktop\나\코드\chrome-extension\kibitzer
```

이 checkout에는 Windows 로그인 시작 서버와 tray가 이미 설치되어 있으며
`127.0.0.1:8765`를 사용합니다. 작업 worktree의 agent는 사용자의 명시적 요청
없이 이 프로세스를 중지하거나 시작 프로그램을 다시 설치해서는 안 됩니다.

macOS의 `macos_install_launch_agent.sh`와 `macos_install_menu_bar_agent.sh`도
실행 당시 checkout의 절대 경로를 LaunchAgent에 기록합니다. 따라서 macOS에서도
로그인 서비스를 설치한 정본 checkout을 유지하고 작업 worktree에서 설치 스크립트를
다시 실행하지 않습니다.

## 작업 전 확인

정본 checkout에서 다음을 확인합니다.

```powershell
git switch dev
git status --short --branch
git worktree list
git pull --ff-only origin dev
```

`dev`가 clean 상태이고 `origin/dev`와 동기화된 경우에만 새 작업을 만듭니다.

## 새 worktree 생성

문서나 저장소 운영 도구 변경은 `chore/`, 제품 기능은 `feature/`, 버그 수정은
`fix/`, Codex 전용 작업은 `codex/`를 사용합니다.

공통 Python helper는 정본이 clean한 `dev`인지, upstream과 동기화됐는지,
브랜치와 폴더가 아직 존재하지 않는지 검사한 뒤 worktree를 생성합니다.

Windows:

```powershell
Set-Location "C:\Users\kimde\Desktop\나\코드\chrome-extension\kibitzer"
& .\.venv\Scripts\python.exe scripts\create_worktree.py A chore/example-task
```

macOS:

```bash
cd /path/to/kibitzer
.venv/bin/python scripts/create_worktree.py A chore/example-task
```

결과는 정본의 sibling인 `kibitzer-fix-server-bug`와 그 안의 새 브랜치입니다. helper는
`hotfix/`를 만들지 않습니다. hotfix는 `main`에서 분기해 `main`과 `dev` 양쪽에
반영해야 하는 별도 절차이므로 `CONTRIBUTING.md`를 따릅니다.

helper를 사용할 수 없는 경우 정본에서 직접 실행합니다.

```powershell
git worktree add -b chore/example-task ..\kibitzer-A dev
git worktree list
```

이미 존재하는 브랜치를 연결할 때는 새 브랜치를 만들지 않습니다.

```powershell
git worktree add ..\kibitzer-A chore/existing-task
```

## worktree 초기화

새 worktree에는 git이 추적하지 않는 의존성, 데이터, 비밀 설정이 복사되지 않습니다.

Windows:

```powershell
Set-Location ..\kibitzer-A
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\windows_setup.ps1
```

macOS:

```bash
cd ../kibitzer-A
bash scripts/macos_setup.sh
```

`.env`와 `configs/models.local.yaml`이 필요하면 정본에서 복사할 수 있지만 비밀을
복제한다는 점을 인지해야 합니다. `.venv`, `node_modules`, `dist`, `data`는 복사하거나
symlink로 공유하지 않습니다.

## Codex 병렬 작업

Codex 작업마다 서로 다른 worktree 폴더를 workspace로 엽니다. 첫 지시에서 폴더와
브랜치를 확인하게 합니다.

```text
현재 workspace와 branch를 git status --short --branch로 확인한다.
이 worktree 밖의 파일은 수정하지 않는다.
```

같은 worktree를 여러 agent 세션이 동시에 수정하거나, 세션이 실행 중인 worktree의
브랜치를 바꾸지 않습니다.

## 병렬 실행과 포트

| 용도 | 포트 | 정책 |
|---|---:|---|
| 설치된 Windows/macOS 로그인 서버 | `8765` | 정본 서비스가 소유. 임의 중지·대체 금지 |
| worktree A 서버/API 검사 | `8766` | 서버 단독 검사 |
| worktree B 서버/API 검사 | `8767` | 서버 단독 검사 |
| 실제 Chrome 확장 연동 | `8765` | 사용자 승인 아래 순차 수행 |

별도 worktree 서버는 고정 포트 Windows 실행 스크립트 대신 직접 실행합니다.

Windows:

```powershell
& .\.venv\Scripts\python.exe `
    -m uvicorn apps.server.app.main:app `
    --host 127.0.0.1 `
    --port 8766
```

macOS:

```bash
.venv/bin/python -m uvicorn apps.server.app.main:app \
  --host 127.0.0.1 --port 8766
```

HTTP smoke script를 대체 포트에 연결하려면 `KIBITZER_BASE_URL`을 설정합니다.
각 worktree의 기본 SQLite 경로는 해당 폴더의 `data/kibitzer.sqlite3`이므로 서로
충돌하지 않습니다.

확장 프로그램은 현재 `http://127.0.0.1:8765`를 사용합니다. 따라서 대체 포트는
서버/API 검사에만 사용하고, 실제 Chrome 연동은 사용자와 유지보수 시간을 정해
순차 수행합니다. 연동할 때는 다른 unpacked Kibitzer build를 비활성화합니다.

## 검증

각 worktree에서 독립적으로 실행합니다.

Windows:

```powershell
& .\.venv\Scripts\python.exe -m pytest apps/server/tests -q
Push-Location apps\extension
npm.cmd run build
Pop-Location
```

macOS:

```bash
.venv/bin/python -m pytest apps/server/tests -q
npm --prefix apps/extension run build
```

## dev 변경 반영

정본에서 `dev`를 갱신한 후 작업 worktree에서 필요한 시점에 rebase합니다.

```powershell
git fetch origin
git rebase origin/dev
```

다른 agent가 같은 worktree를 사용 중이면 rebase하지 않습니다.

## 종료와 정리

먼저 작업 worktree에서 변경을 커밋하고 push한 뒤 clean 상태인지 확인합니다.

```powershell
git status --short
git push -u origin chore/example-task
```

정본에서 worktree를 제거합니다.

```powershell
git worktree list
git worktree remove ..\kibitzer-A
git worktree prune
```

폴더를 먼저 수동 삭제하지 않습니다. `git worktree remove`가 거부하면 해당
worktree의 `git status --short`를 확인합니다. `--force`는 추적되지 않은 파일과
로컬 의존성을 포함해 폴더 전체를 제거하므로, 커밋과 push를 확인한 뒤 사용자가
명시적으로 승인한 경우에만 사용합니다.

이 저장소는 `dev` PR을 squash merge합니다. 따라서 merge 후 `git branch -d`가
브랜치를 병합되지 않은 것으로 볼 수 있습니다. PR이 merge됐고 필요한 commit이
원격에 보존됐음을 확인한 뒤에만 `git branch -D <branch>`를 사용합니다.
