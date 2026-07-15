# D9 Packaging Core Work Order

Decision context: the locally audited pending D9 packaging decision and D10
app/extension boundary. This work order remains self-contained while the
planning-note cleanup is intentionally kept outside this implementation branch.

## Goal

Make the server launch and resolve writable/read-only paths without depending
on the caller's current working directory, then prove those contracts in a
real cross-platform PyInstaller onedir build.

## Scope

- Add one runtime-path resolver with explicit development and frozen-app modes.
- Keep run-from-repo behavior unchanged: repository `configs/`, `.env`, and
  `data/` remain the development locations.
- In frozen mode, read bundled resources from the PyInstaller resource root and
  write state under the per-user platform data directory.
- Allow `KIBITZER_HOME` and `KIBITZER_CONFIG` overrides for deterministic smoke
  tests and advanced local operation.
- Resolve default config path fields by role: writable data/model state,
  user-owned model settings, and bundled read-only resources.
- Replace the stub `kibitzer` entry point with a real server launcher and a
  path-diagnostics command.
- Put the application version in `kibitzer --version` and `GET /health`.
- Move the effective-port file off CWD and onto the runtime data path.
- Add a cross-platform PyInstaller onedir spec containing the default config,
  built-in privacy/persona resources, stamped source version, and port contract.
- Build and launch the frozen executable on both CI platforms; verify its path
  diagnostics, version, `/identity`, `/health`, profile DB, and port file.

## Out of scope

- Signed/notarized release artifacts and installers.
- Windows pystray UI and graceful stop/restart ownership.
- macOS `.app` bundle assembly and nested server lifecycle.
- First-run embedding-model provisioning.
- Onboarding/dashboard, API-key storage, Web Store, Homebrew, and Scoop.
- Migrating an existing repository `data/` directory into a packaged profile.

## Acceptance

- Starting from outside the repository still finds the development resources.
- Frozen-mode path tests cover macOS and Windows locations without touching the
  real user profile.
- Packaged-mode config resolves DB/model/port paths under the app data root and
  built-in personas/privacy rules under the resource root.
- `kibitzer`, `kibitzer serve`, `kibitzer paths`, and `kibitzer --version` have
  deterministic tests.
- `/health` exposes the same non-empty version.
- The onedir executable starts from the packaged resource root while all
  writable smoke state stays under an isolated user profile.
- macOS and Windows CI both build and smoke the packaged executable.
- Full server tests and extension build pass.
