"""Kibitzer judgment review tool.

Local web UI over the SQLite log: per observation it shows the full judgment
trail (Tier 0 score -> audit trigger -> Tier 1 -> Tier 2), the final verdict,
any page label already given in the extension popup, and lets you evaluate
pages as 관련/이탈. Evaluations are stored as page labels (page-facts, same
table the popup writes): observations in the ACTIVE session go through the
app server (so related-labels feed exemplar learning and D8 verdict
propagation); past sessions are recorded directly with `sync_exemplar=False`
(record-only page-facts — no exemplar/replay side effects).

Run:  .venv/bin/python scripts/judgment_review.py
      then open http://127.0.0.1:8799
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from contextlib import closing
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from apps.server.app.config import load_config  # noqa: E402
from apps.server.app.storage.sqlite import SQLiteStore  # noqa: E402

# Resolves the same runtime paths as the app server (dev repo, KIBITZER_HOME,
# or packaged data dir), so --db defaults to the DB the server actually uses.
CONFIG = load_config()


def connect_ro(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{Path(db_path).resolve()}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def list_sessions(db_path: str) -> list[dict]:
    with closing(connect_ro(db_path)) as conn:
        rows = conn.execute(
            """
            SELECT s.id, s.created_at, s.active, g.raw_text AS goal,
                   (SELECT COUNT(*) FROM observations o WHERE o.session_id = s.id) AS obs,
                   (SELECT COUNT(*) FROM page_labels pl JOIN observations o ON o.id = pl.observation_id
                     WHERE o.session_id = s.id) AS labeled
            FROM sessions s LEFT JOIN goals g ON g.session_id = s.id
            ORDER BY s.created_at DESC
            """
        ).fetchall()
    return [dict(r) for r in rows if r["obs"]]


def session_detail(db_path: str, session_id: str) -> dict:
    with closing(connect_ro(db_path)) as conn:
        goal = conn.execute("SELECT raw_text FROM goals WHERE session_id = ?", (session_id,)).fetchone()
        phrases = [
            r["phrase"]
            for r in conn.execute(
                "SELECT phrase FROM goal_derived_exemplars WHERE session_id = ? ORDER BY position",
                (session_id,),
            )
        ]
        active = conn.execute("SELECT id FROM sessions WHERE active = 1 ORDER BY created_at DESC LIMIT 1").fetchone()
        labels = {
            r["observation_id"]: r["label"]
            for r in conn.execute(
                """SELECT pl.observation_id, pl.label FROM page_labels pl
                   JOIN observations o ON o.id = pl.observation_id WHERE o.session_id = ?""",
                (session_id,),
            )
        }
        tier2, tier1_errors, interventions = {}, {}, set()
        for r in conn.execute(
            "SELECT event_type, payload_json FROM event_log WHERE session_id = ? ORDER BY id", (session_id,)
        ):
            try:
                payload = json.loads(r["payload_json"])
            except json.JSONDecodeError:
                continue
            obs_id = payload.get("observation_id")
            if not obs_id:
                continue
            if r["event_type"] == "tier2.confirmed":
                tier2[obs_id] = {"confirm_drift": payload.get("confirm_drift"), "message": payload.get("message")}
            elif r["event_type"] == "tier2.cancelled":
                tier2[obs_id] = {"confirm_drift": False, "message": payload.get("message")}
            elif r["event_type"] == "tier1.provider_error":
                tier1_errors.setdefault(obs_id, []).append(payload.get("error_type") or "error")
            elif r["event_type"] == "intervention.created":
                interventions.add(obs_id)

        observations = []
        for r in conn.execute(
            """SELECT id, ts, url_host, title, verdict, tier_reached, tier1_reason, features_json
               FROM observations WHERE session_id = ? ORDER BY ts ASC, id ASC""",
            (session_id,),
        ):
            f = json.loads(r["features_json"] or "{}")
            observations.append(
                {
                    "id": r["id"],
                    "ts": r["ts"],
                    "host": r["url_host"],
                    "title": r["title"],
                    "r0": f.get("r0"),
                    "tau_ok": f.get("tau_ok"),
                    "exemplar_score": f.get("exemplar_score"),
                    "derived_score": f.get("derived_score"),
                    "title_quality": f.get("title_quality"),
                    "audit_trigger": f.get("audit_trigger"),
                    "audit_cached": bool(f.get("audit_cached")),
                    "tier_reached": r["tier_reached"],
                    "verdict": r["verdict"],
                    "tier1_reason": r["tier1_reason"],
                    "tier1_errors": tier1_errors.get(r["id"], []),
                    "tier2": tier2.get(r["id"]),
                    "intervention": r["id"] in interventions,
                    "label": labels.get(r["id"]),
                }
            )
    return {
        "session_id": session_id,
        "goal": goal["raw_text"] if goal else None,
        "derived_phrases": phrases,
        "is_active": bool(active and active["id"] == session_id),
        "tau_ok": CONFIG.relevance.tau_ok,
        "derived_tau": CONFIG.goal_enrichment.derived_tau,
        "observations": observations,
    }


def save_label(db_path: str, app_server: str, observation_id: str, label: str) -> dict:
    if label not in {"related", "drift"}:
        return {"ok": False, "error": "invalid label"}
    with closing(connect_ro(db_path)) as conn:
        row = conn.execute("SELECT session_id FROM observations WHERE id = ?", (observation_id,)).fetchone()
        if not row:
            return {"ok": False, "error": "observation not found"}
        active = conn.execute("SELECT id FROM sessions WHERE active = 1 ORDER BY created_at DESC LIMIT 1").fetchone()
    if active and active["id"] == row["session_id"]:
        # Active session: go through the app server so related-labels feed
        # exemplar learning exactly like the popup.
        try:
            req = urllib.request.Request(
                f"{app_server.rstrip('/')}/observations/{quote(observation_id, safe='')}/label",
                data=json.dumps({"label": label}).encode(),
                headers={"content-type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=8) as resp:
                if resp.status == 200:
                    return {"ok": True, "via": "server"}
                return {"ok": False, "error": f"app server returned HTTP {resp.status}"}
        except Exception as exc:
            return {
                "ok": False,
                "error": f"active session requires the app server ({type(exc).__name__})",
            }
    store = SQLiteStore(db_path)
    store.record_page_label(
        session_id=row["session_id"],
        observation_id=observation_id,
        label=label,
        exemplar_cap=CONFIG.relevance.exemplar_cap,
        sync_exemplar=False,
    )
    return {"ok": True, "via": "direct-record-only"}


PAGE = """<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>Kibitzer 판정 리뷰</title>
<style>
:root { --bg:#fff; --card:#f4f4f5; --tx:#18181b; --mut:#71717a; --line:#e4e4e7; --acc:#2563eb;
  --ok-bg:#dcfce7; --ok-tx:#166534; --dr-bg:#fef3c7; --dr-tx:#92400e; --bad-bg:#fee2e2; --bad-tx:#991b1b;
  --good-tx:#166534; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#202124; --card:#2d2e31; --tx:#e8eaed; --mut:#9aa0a6; --line:#3c4043; --acc:#8ab4f8;
    --ok-bg:#1e3a2a; --ok-tx:#81c995; --dr-bg:#3d3222; --dr-tx:#fdd663; --bad-bg:#46201f; --bad-tx:#f28b82;
    --good-tx:#81c995; } }
body { margin:0; background:var(--bg); color:var(--tx); font:14px/1.5 system-ui,-apple-system,"Apple SD Gothic Neo",sans-serif; }
.wrap { max-width: 980px; margin: 0 auto; padding: 18px 20px 60px; }
h1 { font-size: 17px; margin: 0 0 12px; display:flex; align-items:center; gap:10px; }
select, button.f { font:inherit; padding:5px 9px; border:1px solid var(--line); border-radius:7px; background:var(--bg); color:var(--tx); }
.goalbar { background:var(--card); border-radius:10px; padding:10px 14px; margin:10px 0 6px; }
.goalbar b { font-size:15px; }
.phrase { display:inline-block; font-size:11.5px; color:var(--mut); border:1px solid var(--line); border-radius:999px; padding:1px 8px; margin:3px 4px 0 0; }
.sum { color:var(--mut); font-size:12.5px; margin: 6px 2px 14px; }
.filters { display:flex; gap:6px; margin-bottom: 12px; flex-wrap:wrap; }
button.f.on { border-color:var(--acc); outline:1px solid var(--acc); }
.obs { background:var(--card); border-radius:10px; padding:10px 14px; margin-bottom:9px; }
.t1 { display:flex; gap:8px; align-items:baseline; }
.t1 .time { color:var(--mut); font-size:11.5px; white-space:nowrap; }
.t1 .host { color:var(--mut); font-size:11.5px; white-space:nowrap; max-width:180px; overflow:hidden; text-overflow:ellipsis; }
.t1 .title { font-weight:600; font-size:13.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
.trail { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin:8px 0; }
.chip { font-size:11.5px; padding:2px 9px; border-radius:999px; background:var(--bg); border:1px solid var(--line); white-space:nowrap; }
.chip.ok { background:var(--ok-bg); color:var(--ok-tx); border-color:transparent; }
.chip.drift { background:var(--dr-bg); color:var(--dr-tx); border-color:transparent; }
.chip.err { background:var(--bad-bg); color:var(--bad-tx); border-color:transparent; }
.chip.audit { border-style:dashed; color:var(--mut); }
.arrow { color:var(--mut); font-size:11px; }
.reason { font-size:12px; color:var(--mut); margin:2px 0 6px; }
.evalrow { display:flex; gap:8px; align-items:center; margin-top:4px; }
.evalrow .lbl { font-size:12px; color:var(--mut); }
button.ev { font:inherit; font-size:12px; padding:3px 12px; border:1px solid var(--line); border-radius:7px; background:var(--bg); color:var(--tx); cursor:pointer; }
button.ev:hover { border-color:var(--mut); }
button.ev.sel { border-color:var(--acc); outline:1px solid var(--acc); }
.verdictmark { font-size:12px; font-weight:600; margin-left:auto; }
.verdictmark.good { color:var(--good-tx); }
.verdictmark.bad { color:var(--bad-tx); }
.empty { color:var(--mut); text-align:center; padding:30px 0; }
</style></head><body><div class="wrap">
<h1>Kibitzer 판정 리뷰 <select id="sess"></select></h1>
<div id="goalbar" class="goalbar" hidden></div>
<div id="sum" class="sum"></div>
<div class="filters">
  <button class="f on" data-f="all">전체</button>
  <button class="f" data-f="mismatch">판정≠평가</button>
  <button class="f" data-f="uneval">미평가</button>
  <button class="f" data-f="tier1">Tier 1 이상</button>
  <button class="f" data-f="audited">감사됨</button>
</div>
<div id="list"></div>
</div>
<script>
const $ = (s) => document.querySelector(s);
let DATA = null, FILTER = "all";
const esc = (t) => (t ?? "").toString().replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt = (v) => v === null || v === undefined ? "–" : Number(v).toFixed(3);

async function loadSessions() {
  try {
    const sessions = await (await fetch("/api/sessions")).json();
    $("#sess").innerHTML = sessions.map(s =>
      `<option value="${s.id}">${esc((s.goal || "(목표 없음)").slice(0, 24))} · ${s.obs}개 · ${s.created_at.slice(5, 10)}${s.active ? " · 활성" : ""}</option>`).join("");
    if (sessions.length) loadSession(sessions[0].id);
    else $("#list").innerHTML = '<div class="empty">리뷰할 관측이 없어요</div>';
  } catch (error) {
    $("#list").innerHTML = '<div class="empty">데이터베이스를 읽지 못했어요</div>';
  }
}
async function loadSession(id) {
  DATA = await (await fetch("/api/session?id=" + encodeURIComponent(id))).json();
  render();
}
function agreement(o) {
  if (!o.label || !o.verdict) return null;
  const pageIsRelated = o.label === "related";
  const saidOk = o.verdict === "OK";
  return pageIsRelated === saidOk;
}
function chipTrail(o) {
  const bits = [];
  if (o.r0 === null || o.r0 === undefined) return '<span class="chip">판정 전</span>';
  // Old rows predate the per-observation tau_ok feature; for those, trust the
  // stored verdict at tier 0 instead of recomputing against today's config tau.
  const t0ok = o.tau_ok !== null && o.tau_ok !== undefined ? o.r0 >= o.tau_ok
    : (o.tier_reached === 0 && o.verdict ? o.verdict === "OK" : o.r0 >= DATA.tau_ok);
  const exemplar = o.exemplar_score === null || o.exemplar_score === undefined ? "" : ` · e ${fmt(o.exemplar_score)}`;
  const derived = o.derived_score === null || o.derived_score === undefined ? "" : ` · d ${fmt(o.derived_score)}`;
  bits.push(`<span class="chip ${t0ok ? "ok" : "drift"}">T0 ${t0ok ? "OK" : "DRIFT"} · r0 ${fmt(o.r0)}${exemplar}${derived}</span>`);
  if (o.title_quality && o.title_quality !== "content_specific") bits.push(`<span class="chip audit">${esc(o.title_quality)}</span>`);
  if (o.audit_trigger) bits.push(`<span class="chip audit">감사: ${esc(o.audit_trigger)}${o.audit_cached ? " · 재사용" : ""}</span>`);
  if (o.tier_reached >= 1) {
    bits.push('<span class="arrow">→</span>');
    bits.push(`<span class="chip ${o.verdict === "OK" ? "ok" : "drift"}">T1 ${esc(o.verdict)}</span>`);
  }
  for (const e of o.tier1_errors) bits.push(`<span class="chip err">T1 ${esc(e)}</span>`);
  if (o.tier2) {
    bits.push('<span class="arrow">→</span>');
    bits.push(`<span class="chip ${o.tier2.confirm_drift ? "drift" : "ok"}">T2 ${o.tier2.confirm_drift ? "이탈 확정" : "개입 취소"}</span>`);
  }
  if (o.intervention) bits.push('<span class="chip">🔔 개입</span>');
  return bits.join("");
}
function render() {
  const d = DATA;
  $("#goalbar").hidden = false;
  $("#goalbar").innerHTML = `<b>${esc(d.goal || "(목표 없음)")}</b>${d.is_active ? ' <span class="chip ok">활성 세션</span>' : ""}<br>` +
    (d.derived_phrases.length ? d.derived_phrases.map(p => `<span class="phrase">${esc(p)}</span>`).join("") : '<span class="phrase">파생 구문 없음</span>');
  const evald = d.observations.filter(o => o.label);
  const good = evald.filter(o => agreement(o) === true).length;
  const bad = evald.filter(o => agreement(o) === false).length;
  const t1n = d.observations.filter(o => o.tier_reached >= 1).length;
  const audited = d.observations.filter(o => o.audit_trigger).length;
  const cached = d.observations.filter(o => o.audit_cached).length;
  const auditPart = audited ? ` · 감사 ${audited} (재사용 ${cached})` : "";
  $("#sum").textContent = `관측 ${d.observations.length} · Tier1 도달 ${t1n}${auditPart} · 평가 ${evald.length}건 (잘 판단 ${good} · 잘못 판단 ${bad}) · τ=${d.tau_ok}`;
  $('button.f[data-f="audited"]').hidden = !audited;
  const rows = d.observations.filter(o => {
    if (FILTER === "mismatch") return agreement(o) === false;
    if (FILTER === "uneval") return !o.label && o.verdict;
    if (FILTER === "tier1") return o.tier_reached >= 1;
    if (FILTER === "audited") return !!o.audit_trigger;
    return true;
  });
  $("#list").innerHTML = rows.length ? rows.map(o => {
    const agr = agreement(o);
    const mark = agr === null ? "" :
      `<span class="verdictmark ${agr ? "good" : "bad"}">${agr ? "✓ 잘 판단" : "✗ 잘못 판단"}</span>`;
    return `<div class="obs" id="o-${o.id}">
      <div class="t1"><span class="time">${esc(o.ts.slice(11, 19))}</span><span class="host">${esc(o.host || "")}</span><span class="title">${esc(o.title || "(제목 없음)")}</span></div>
      <div class="trail">${chipTrail(o)}</div>
      ${o.tier1_reason ? `<div class="reason">근거: ${esc(o.tier1_reason)}</div>` : ""}
      ${o.tier2 && o.tier2.message ? `<div class="reason">메시지: ${esc(o.tier2.message)}</div>` : ""}
      <div class="evalrow"><span class="lbl">이 페이지는 실제로:</span>
        <button class="ev ${o.label === "related" ? "sel" : ""}" onclick="setLabel('${o.id}','related')">관련</button>
        <button class="ev ${o.label === "drift" ? "sel" : ""}" onclick="setLabel('${o.id}','drift')">이탈</button>
        ${mark}</div></div>`;
  }).join("") : '<div class="empty">해당하는 관측이 없어요</div>';
}
async function setLabel(id, label) {
  try {
    const res = await (await fetch("/api/label", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ observation_id: id, label }) })).json();
    if (res.ok) {
      const o = DATA.observations.find(x => x.id === id);
      if (o) o.label = label;
      render();
    } else alert("저장 실패: " + (res.error || "unknown"));
  } catch (error) {
    alert("저장 실패: 리뷰 서버에 연결할 수 없어요");
  }
}
$("#sess").addEventListener("change", (e) => loadSession(e.target.value));
document.querySelectorAll("button.f").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll("button.f").forEach(x => x.classList.remove("on"));
  b.classList.add("on"); FILTER = b.dataset.f; render();
}));
loadSessions();
</script></body></html>"""


def make_handler(db_path: str, app_server: str):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # quiet
            pass

        def _json(self, body, status=200):
            data = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("cache-control", "no-store")
            self.send_header("x-content-type-options", "nosniff")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            url = urlparse(self.path)
            if url.path == "/":
                data = PAGE.encode()
                self.send_response(200)
                self.send_header("content-type", "text/html; charset=utf-8")
                self.send_header("cache-control", "no-store")
                self.send_header("x-content-type-options", "nosniff")
                self.send_header("referrer-policy", "no-referrer")
                self.send_header(
                    "content-security-policy",
                    "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; "
                    "connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
                )
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            elif url.path == "/api/sessions":
                self._json(list_sessions(db_path))
            elif url.path == "/api/session":
                session_id = parse_qs(url.query).get("id", [""])[0]
                self._json(session_detail(db_path, session_id))
            else:
                self._json({"error": "not found"}, 404)

        def do_POST(self):
            if urlparse(self.path).path != "/api/label":
                self._json({"error": "not found"}, 404)
                return
            length = int(self.headers.get("content-length") or 0)
            try:
                body = json.loads(self.rfile.read(length))
                label = body["label"]
                if label not in ("related", "drift"):
                    raise ValueError(label)
                self._json(save_label(db_path, app_server, body["observation_id"], label))
            except Exception as exc:
                self._json({"ok": False, "error": str(exc)}, 400)

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description="Kibitzer judgment review UI")
    parser.add_argument("--db", default=CONFIG.server.db_path)
    parser.add_argument("--port", type=int, default=8799)
    parser.add_argument("--app-server", default="http://127.0.0.1:8765")
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(args.db, args.app_server))
    print(f"judgment review: http://127.0.0.1:{args.port}  (db: {args.db})")
    server.serve_forever()


if __name__ == "__main__":
    main()
