// Classic (non-module) chrome API stub injected ahead of the real popup/options bundles.
// Returns fixed, self-consistent state so the shipped UI code renders a realistic scene
// with no service worker behind it. Scene is chosen with ?scene= on the iframe URL.
(function () {
  var params = new URLSearchParams(location.search);
  var scene = params.get("scene") || "";
  var MIN = 60000;

  // Demo goal defaults to startedAt: 0 (epoch) — hugely overrun, so the sundial shows the
  // moon/overtime state. Scenes that want the daytime sun instead pass ?elapsedMin=<n> to
  // pick a point on the dome (see sundial.ts: frac = elapsedMin / availableMinutes).
  var elapsedMinParam = Number(params.get("elapsedMin"));
  var goalStartedAt = Number.isFinite(elapsedMinParam) && params.has("elapsedMin") ? Date.now() - elapsedMinParam * MIN : 0;

  // ?cards=highlight,compare-last,focus — which report cards the summary shows. The shipped
  // code picks 5 of 11 at weighted random per session (lib/reportCards.ts); pinning them keeps
  // a capture reproducible. Omit to keep the fixture's own list.
  var cardsParam = params.get("cards");

  // ?part=head|cards — render only one slice of the summary, so a scene can lay the summary
  // out as two side-by-side columns instead of one tall card. "head" is everything down to the
  // persona one-liner; "cards" is only the report cards. Omit for the whole thing.
  var part = params.get("part") || "";

  // ?persona=<key> — which persona is selected/highlighted (options page persona tab, and the
  // "말투" line in the popup's goal card). Defaults to dry_kibitzer, matching every capture
  // taken before this param existed.
  var personaParam = params.get("persona") || "dry_kibitzer";

  // ?lede=<text> — override the options page's intro line (.lede) with different copy, for a
  // capture that wants shorter/different wording without touching the shipped page text.
  var ledeParam = params.get("lede");

  // ?fontBump=persona — bump every font-size inside the persona tab's #pane-persona by 1px,
  // for a capture where the tab is shown larger than its real popup/options size and the
  // shipped sizes read a touch small blown up. Scoped to that one pane; nothing else shifts.
  var fontBumpPersona = params.get("fontBump") === "persona";

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
    cards: cardsParam ? cardsParam.split(",") : ["highlight"],
    comment: {
      status: "ready",
      text: "78분 중 61분을 논문에 쓰셨습니다. 나머지 17분의 행방은 굳이 여쭙지 않겠습니다.",
    },
    seen: false,
    createdAt: 0,
  };

  // The popup's active view needs a live goal; the summary view needs none.
  var STATE_ACTIVE = {
    goal: { text: "졸업논문 관련연구 정리", availableMinutes: 90, startedAt: goalStartedAt },
    s: 82,
    accelTier: 0,
    snoozedUntil: null,
    judgeEnabled: true,
    persona: personaParam,
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

    // ?part= slices the summary so a scene can run it as two columns. Hiding is done here,
    // inside the popup document, rather than by cropping from the scene — that way each slice
    // sizes itself and there are no pixel offsets to re-measure when the fixture changes.
    // The '세션 더보기' toggle and '확인' button go in both slices: they are real UI, but a
    // still image has nothing to toggle or confirm.
    if (part === "head") {
      s.textContent += "#sumMore,#sumReport,#sumDone{display:none!important}";
    } else if (part === "cards") {
      s.textContent +=
        // h1 goes too — the left slice already carries the KIBITZER wordmark, and repeating it
        // at the top of the second column would read as two separate popups.
        // .divider is the <hr> that normally sits between the stat rows and the '세션
        // 더보기' button — with the stats and button both hidden, it was left floating right
        // above the first card as a stray horizontal rule.
        "h1,.sumlabel,.sumgoal,.stat,#sumTopWrap,#sumMore,#sumDone,.comment-head,.comment-text,.comment-note,.divider" +
        "{display:none!important}" +
        // #sumReport's first card carries a 10px top margin meant to separate it from the
        // one-liner above; with nothing above it that reads as a stray gap. Trim the body's own
        // padding too (14px shipped default on all four sides, meant to frame the stat rows we
        // no longer show here) — top AND bottom the same, so the white space above the first
        // card matches the white space below the last one.
        "#sumReport>.card:first-child{margin-top:0}" +
        "body{padding-top:6px;padding-bottom:6px}" +
        // 🎯 집중 is the only card in this slice's rotation that uses .metrics, so widening it
        // to 3 columns here only affects that card. The shipped 12px column-gap reads uneven
        // across 3 columns because it's small enough that each gap's apparent width is mostly
        // set by how much of its column the label text fills (최장 집중 연속 vs 첫 딴짓까지 are
        // different lengths) — widening the gap swamps that difference so the three read as
        // evenly spaced.
        ".metrics{grid-template-columns:repeat(3,1fr);gap:8px 22px}" +
        // 📉 몰입 곡선: pull the legend right up under the chart (no gap at all) and shave the
        // chart's own height too — together that's what shortens the card.
        ".scurve{height:44px}.scurve-legend{margin-top:0}";
    }

    // ?fontBump=persona: +1px on every font-size declared inside #pane-persona (탭 제목,
    // "Kibitzer 설정", .lede are all outside that section, so they're untouched). Each
    // selector below is scoped with #pane-persona so it doesn't also bump the same classes
    // (.hint, .card > h3) used in other tabs.
    if (fontBumpPersona) {
      s.textContent +=
        "#pane-persona .card>h3{font-size:14px!important}" +
        "#pane-persona .pcard .pn{font-size:16px!important}" +
        "#pane-persona .hint{font-size:13px!important}" +
        "#pane-persona .pqtag{font-size:14px!important}" +
        "#pane-persona .pqtxt{font-size:16px!important}";
    }
    document.head.appendChild(s);

    // ?lede=<text>: swap the options page's intro paragraph for different copy, without
    // touching the shipped page. .lede is static markup, already in the DOM at this point.
    if (ledeParam) {
      var lede = document.querySelector(".lede");
      if (lede) lede.textContent = ledeParam;
    }
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
