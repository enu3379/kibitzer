// Classic (non-module) chrome API stub injected ahead of the real popup/options bundles.
// Returns fixed, self-consistent state so the shipped UI code renders a realistic scene
// with no service worker behind it. Scene is chosen with ?scene= on the iframe URL.
(function () {
  var scene = new URLSearchParams(location.search).get("scene") || "";
  var MIN = 60000;

  var PERSONAS = [
    { key: "navigation", name: "내비게이션", tier: "default" },
    { key: "tsundere", name: "츤데레", tier: "default" },
    { key: "documentary", name: "다큐 내레이터", tier: "default" },
    { key: "dry_kibitzer", name: "영국 집사", tier: "default" },
    { key: "yandere", name: "얀데레", tier: "lab" },
    { key: "chungcheong", name: "충청도 이웃", tier: "lab" },
    { key: "kyoto", name: "교토 사모님", tier: "lab" },
    { key: "baseball_caster", name: "야구 캐스터", tier: "lab" },
    { key: "game_caster", name: "게임 캐스터", tier: "lab" },
    { key: "quiet_coach", name: "열혈 코치", tier: "lab" },
  ];

  var SUMMARY = {
    epoch: 7,
    stats: {
      goalText: "졸업논문 관련연구 정리",
      sessionMinutes: 92,
      activeMs: 78 * MIN,
      pagesTotal: 41,
      pagesOk: 32,
      okRatio: 32 / 41,
      validMs: 61 * MIN,
      nagCount: 3,
      topPage: {
        title: "Attention Is All You Need — arXiv",
        host: "arxiv.org",
        ms: 23 * MIN,
        verdict: "OK",
      },
    },
    report: {
      distinctHosts: 9,
      avgPageMs: 114000,
      longestFocusMs: 23 * MIN,
      timeToFirstDriftMs: 26 * MIN,
      awayCount: 1,
      awayMs: 6 * MIN,
      nagCount: 3,
      nagActed: 2,
      goalMinutes: 90,
      activeMinutes: 78,
      driftVisits: 9,
      driftMs: 17 * MIN,
      topDriftHosts: [
        { host: "youtube.com", label: "▶️ 유튜브", friendly: "youtube", ms: 9 * MIN, verdict: "DRIFT", visits: 5 },
        { host: "instagram.com", label: "📷 인스타그램", friendly: "instagram", ms: 5 * MIN, verdict: "DRIFT", visits: 3 },
      ],
      longestDriftMs: 7 * MIN,
      avgDriftEpisodeMs: 3 * MIN,
      driftClock: "late",
      secondHalfTrend: "down",
      ending: "OK",
      lowestS: 34,
      mvp: { title: "Attention Is All You Need — arXiv", host: "arxiv.org", ms: 23 * MIN },
      villain: { host: "youtube.com", label: "▶️ 유튜브", friendly: "youtube", ms: 9 * MIN, verdict: "DRIFT", visits: 5 },
      siteBars: [
        { host: "arxiv.org", label: "arxiv.org", friendly: "other", ms: 31 * MIN, verdict: "OK", visits: 12 },
        { host: "scholar.google.com", label: "scholar.google.com", friendly: "other", ms: 18 * MIN, verdict: "OK", visits: 8 },
        { host: "youtube.com", label: "▶️ 유튜브", friendly: "youtube", ms: 9 * MIN, verdict: "DRIFT", visits: 5 },
      ],
      sCurve: [72, 78, 84, 88, 91, 86, 74, 58, 41, 34, 47, 63, 71, 76, 80],
    },
    comparison: {
      sessions: 6,
      vsLast: { okRatioDelta: 0.11, validMsDelta: 12 * MIN, driftVisitsDelta: -3 },
      vsAvg: { okRatioDelta: 0.06, validMsDelta: 7 * MIN, driftVisitsDelta: -1 },
      lastSCurve: [70, 71, 68, 62, 55, 49, 44, 40, 38, 42, 51, 57, 60, 62, 64],
      avgSCurve: null,
    },
    cards: ["highlight"],
    comment: {
      status: "ready",
      text: "78분 중 61분을 논문에 쓰셨습니다. 나머지 17분의 행방은 굳이 여쭙지 않겠습니다.",
    },
    seen: false,
    createdAt: 0,
  };

  // The popup's active view needs a live goal; the summary view needs none.
  var STATE_ACTIVE = {
    goal: { text: "졸업논문 관련연구 정리", availableMinutes: 90, startedAt: 0 },
    s: 82,
    accelTier: 0,
    snoozedUntil: null,
    judgeEnabled: true,
    persona: "dry_kibitzer",
    personas: PERSONAS,
    health: null,
  };
  var STATE_IDLE = Object.assign({}, STATE_ACTIVE, { goal: null });

  var SETTINGS = {
    tauOk: 0.59,
    quietHours: { enabled: false, start: "22:00", end: "08:00" },
    ttsEnabled: false,
  };

  var DOMAIN_LISTS = {
    block: ["instagram.com", "x.com", "dcinside.com"],
    allow: ["arxiv.org", "scholar.google.com", "docs.python.org"],
  };

  var JUDGE = {
    accounts: {},
    routes: {
      tier1: { provider: "ollama", model: "nemotron-3-super" },
      tier2: { provider: "ollama", model: "minimax-m3" },
    },
  };

  function reply(msg) {
    switch (msg && msg.type) {
      case "get-state":
        return scene === "summary" ? STATE_IDLE : STATE_ACTIVE;
      case "get-session-summary":
        return { summary: scene === "summary" ? SUMMARY : null };
      case "get-settings":
        return SETTINGS;
      case "get-domain-lists":
        return DOMAIN_LISTS;
      case "get-judge-settings":
        return JUDGE;
      case "get-usage":
        return { rows: [], since: 0 };
      default:
        return undefined;
    }
  }

  var store = { "kibitzer:goal-ever-declared:v1": 1 };

  window.chrome = {
    runtime: {
      sendMessage: function (msg) {
        return Promise.resolve(reply(msg));
      },
      openOptionsPage: function () {},
      getURL: function (p) {
        return p;
      },
      onMessage: { addListener: function () {}, removeListener: function () {} },
      lastError: undefined,
    },
    storage: {
      local: {
        get: function (key) {
          var out = {};
          var keys = typeof key === "string" ? [key] : Array.isArray(key) ? key : Object.keys(key || {});
          keys.forEach(function (k) {
            if (k in store) out[k] = store[k];
          });
          return Promise.resolve(out);
        },
        set: function (obj) {
          Object.assign(store, obj);
          return Promise.resolve();
        },
      },
      onChanged: { addListener: function () {} },
    },
    tabs: { query: function () { return Promise.resolve([]); } },
  };

  // Freeze animations/carets so the capture is deterministic.
  window.addEventListener("DOMContentLoaded", function () {
    var s = document.createElement("style");
    // The capture host runs macOS in dark mode, so `prefers-color-scheme: dark` matches and
    // the options page swaps its whole palette. Re-declare the shipped LIGHT token values
    // last in the cascade so the render matches the light theme the composite is built for.
    s.textContent =
      "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;" +
      "transition-duration:0s!important;caret-color:transparent!important}" +
      ":root{color-scheme:light!important;" +
      "--page:#f2f5f3;--page-ink:#1c2420;--page-ink-2:#57635c;--page-ink-3:#8a958f;" +
      "--surface:#ffffff;--surface-2:#eef3f0;--line:#dce4df;--line-soft:#e7ede9;" +
      "--accent:#1e7a4c;--accent-ink:#ffffff;--accent-soft:#e2f1e8;" +
      "--ok-fg:#175f3b;--err:#bf4540;--err-soft:#f7e2e0;--err-fg:#8f322c;" +
      "--sd-ink:#6e6960;--sd-ink3:#9b968c;--sd-line:#e6e3dc;--sd-leaf:#5aa63c;--sd-bg:#ffffff}";
    document.head.appendChild(s);
  });

  // Scene-specific post-render nudges (the shipped UI keeps these behind a click).
  window.addEventListener("load", function () {
    if (scene === "summary") {
      setTimeout(function () {
        var more = document.getElementById("sumMore");
        if (more && more.getAttribute("aria-expanded") !== "true") more.click();
      }, 120);
    }
  });
})();
