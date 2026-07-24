# Security review — beyond prompt injection (2026-07-15)

Focused review of the Kibitzer attack surface *other than* the Tier-2 prompt
injection already handled in D10
([security-redteam-prompt-extraction.md](security-redteam-prompt-extraction.md)).
Scope: the local FastAPI server, its HTTP surface, secret handling, the SQLite
layer, the TTS path, and the MV3 extension. Findings are ranked; each says
whether it was **confirmed** and how to remediate. Several high-risk areas were
checked and found **safe** — listed at the end so they are not re-reviewed blind.

## Findings

### F1 — [MEDIUM] Local API has no origin authentication (DNS-rebinding + local-process reachable)

**Where:** `apps/server/app/main.py` (`create_app`) — no CORS middleware, no
`TrustedHostMiddleware`, no auth token on any route. Server binds `127.0.0.1:8765`
(`scripts/macos_run_server.sh:14`, `scripts/windows_run_server.ps1:18`), so it is
not LAN-exposed, but it is reachable from the browser and from any local process.

**What's exposed:** every route is unauthenticated. Reads leak
browsing-derived private data — declared goals, observation history (page titles,
hosts, verdicts, timestamps), focus stats, top drift hosts, judgment reasons
(`GET /sessions/current`, `/settings`, history endpoints). Writes let a caller
disable the guard or corrupt state (`PUT /settings` persona/voice, `POST
/sessions/current/{snooze,end,goal}`, `POST /observations/browser-nav`,
`/observations/{id}/label`, `/feedback`).

**Why the current setup only *incidentally* resists web pages:** the routes
require `Content-Type: application/json`, so a cross-origin `fetch` triggers a
CORS **preflight**; with no CORS middleware the preflight gets no
`Access-Control-Allow-Origin` and the browser blocks the call. That is a real but
**accidental** barrier, and it is bypassed by:

- **DNS rebinding** (the primary concern). A remote page on `evil.com:8765` whose
  DNS re-resolves to `127.0.0.1` makes requests that are **same-origin**
  (`evil.com` → `evil.com`), so CORS never applies and the JS can read responses.
  The server accepts them because it never checks the `Host` header. Result:
  drive-by read/exfil of the user's goals + browsing history and remote control
  of the guard, from any site the user happens to visit.
- **Any local process** — no browser, no CORS, no barrier at all.

Caveats (do not overstate): rebinding needs the victim to linger on the attacker
page for seconds, the attacker to serve on port 8765, and it partially collides
with Chrome's Private Network Access rollout. It remains a standard, well-known
threat for localhost companion servers.

**Fix (primary):** reject requests whose `Host` is not an allowlisted loopback
name. A `Host` allowlist (`127.0.0.1`, `localhost`, `[::1]`, each with the
configured port) fully defeats rebinding, because after rebinding the `Host`
header still carries the attacker's domain. Cheapest form is Starlette
`TrustedHostMiddleware(allowed_hosts=[...])`, driven by a new
`server.allowed_hosts` config field. **Test note:** `TestClient` sends
`Host: testserver` and the suite builds `TestClient(create_app(...))` in ~13
files — the middleware must take its allowlist from config so tests can pass a
valid host (or the shared config helper adds `testserver`), otherwise every API
test 400s.

**Fix (defense-in-depth):** a per-install random token minted at first run,
stored in `chrome.storage.local`, sent by the extension on every request and
required by the server. Web pages cannot read the extension's storage, so even a
same-origin rebound request lacks the token. Slots into the existing "D8 / D7-13
localhost hardening" track.

### F2 — [LOW] No length cap on `Goal.raw_text` and `RawObservation.title`

**Where:** `apps/server/app/schemas.py:21` (`title: str = ""`),
`schemas.py:52` (`raw_text: str`). `PageExcerpt.text` *is* capped
(`max_length=50000`, then truncated to 3000 for Tier-2), but goal text and page
titles are unbounded.

**Impact:** an unbounded `document.title` or goal string is persisted to SQLite
and interpolated into **every** Tier-1/Tier-2 LLM payload — cost, latency, and
storage amplification (a page can set a multi-megabyte title). Low severity
(local, no memory-safety impact), but a cheap correctness/DoS hardening.

**Fix:** `title: str = Field(default="", max_length=2000)` and a generous
`max_length` on the goal request model. Verify no legitimate test sends a longer
value (none currently do).

### F3 — [INFO] `say` TTS argument injection (not shell injection)

**Where:** `apps/server/app/core/voice.py:19` —
`create_subprocess_exec("say", "-v", voice, "-r", str(rate), text, ...)`.

This uses `exec`, **not** a shell, so there is **no command injection** — `text`
is a single argv element. The only residual: a `text` that begins with `-` could
be parsed by `say` as an option (e.g. `-o file` writes audio to disk). `text` is
the clamped 2–3-sentence Korean persona message, so this is near-theoretical.
**Left unpatched deliberately** — adding a `--` end-of-options separator depends
on `say`'s getopt behavior, which cannot be verified in this environment; a wrong
guess would break voice output. Flagged for a macOS-side check.

### F4 — [INFO] Broad extension host permissions + full page read

**Where:** `apps/extension/manifest.json:7` —
`host_permissions: ["http://127.0.0.1:8765/*", "http://*/*", "https://*/*"]`
plus `scripting`. The extension can read content from and inject into **every**
page. This is inherent to capturing page excerpts, but it is a large privacy
surface: a compromised or supply-chain-tampered build would have full web-read
access. Mitigations are process (signed releases, review), not code.

## Checked and found safe (no action)

- **TTS command injection** — `create_subprocess_exec` with fixed argv, no shell (F3 covers the argv nuance).
- **SQL injection** — `storage/sqlite.py` uses parameterized queries throughout; no interpolated SQL found.
- **Secret exposure** — no route returns API keys/tokens (`/settings`, `/health` return only knobs/status). `.env` and `configs/models.local.yaml` are gitignored **and untracked** (verified with `git ls-files`).
- **Extension XSS** — the on-page toast sets attacker-controlled `message` / `contextLabel` via `textContent`, not `innerHTML` (`content/toastOverlay.ts:89,92`); the popup wraps every untrusted server field (`title`, `url_host`, `tier1_reason`, `message`, `url`, `goal`) in a correct HTML escaper (`popup/popup.ts:94` — escapes `& < > " '`).
- **LAN exposure** — server binds `127.0.0.1` on both macOS and Windows entrypoints, not `0.0.0.0`.
- **Web→service-worker messaging** — no `externally_connectable` in the manifest, so web pages cannot message the background worker; `onMessage` is extension-internal only.
- **Excerpt privacy** — raw page excerpts are not persisted; only an
  `intervention.request_excerpt` event *marker* is logged (confirmed by
  `scripts/smoke_tier2_http_real.py`, which asserts the raw marker never reaches
  the DB).

## Recommendation

F1 is the one worth scheduling — it is the difference between "localhost tool" and
"any website you visit can read your browsing goals and silence the guard." Fix =
`Host` allowlist middleware (+ optional per-install token), folded into the D8 /
D7-13 localhost-hardening work. F2 is a cheap add-on. F3/F4 are informational.
