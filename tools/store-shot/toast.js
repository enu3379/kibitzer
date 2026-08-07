// Extracted verbatim from dist/background.js (the shipped bundle).
function showKibitzerToast(payload) {
  const HOST_ID = "kibitzer-toast-host";
  document.getElementById(HOST_ID)?.remove();
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "position:fixed;right:18px;bottom:16px;z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "open" });
  const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  const surface = dark ? "#26272b" : "#ffffff";
  const textPrimary = dark ? "#ececef" : "#1F2937";
  const textMuted = dark ? "#9a9aa0" : "#6b7280";
  const buttonBorder = dark ? "#46474d" : "#d1d5db";
  const ink = dark ? "#111318" : "#1F2937";
  const eye = "#F9FAFB";
  const celebration = payload.kind === "celebration";
  const accent = celebration ? "#79B7A0" : "#10B981";
  shadow.innerHTML = `
    <style>
      .wrap { width: 300px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif; animation: kbz-in .34s cubic-bezier(.2,.8,.3,1); transition: transform .25s ease, opacity .25s ease; }
      .wrap.out { transform: translateY(20px); opacity: 0; }
      @keyframes kbz-in { from { transform: translateY(26px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
      .peek { display: block; width: 64px; margin: 0 0 -6px 18px; animation: kbz-peek .4s .08s cubic-bezier(.2,.8,.3,1) backwards; }
      @keyframes kbz-peek { from { transform: translateY(16px); } to { transform: translateY(0); } }
      /* Celebration: same slide, springier curve \u2014 a small hop, not a fanfare. */
      .cel .peek { animation: kbz-peek .5s .08s cubic-bezier(.34,1.56,.64,1) backwards; }
      .cel .msg { margin-bottom: 2px; }
      .cel .ctx { margin-bottom: 2px; }
      .card { position: relative; background: ${surface}; border: 1.5px solid ${accent}; border-radius: 12px; padding: 12px 14px; box-shadow: 0 6px 24px rgba(0,0,0,.18); cursor: pointer; }
      .hands { position: absolute; top: -7px; left: 18px; width: 64px; pointer-events: none; }
      .top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
      .brand { font-size: 10.5px; color: ${textMuted}; }
      .close { border: 0; background: none; padding: 2px 4px; font-size: 12px; color: ${textMuted}; cursor: pointer; line-height: 1; }
      .msg { font-size: 13px; line-height: 1.55; color: ${textPrimary}; margin: 0 0 4px; }
      .ctx { font-size: 10.5px; color: ${textMuted}; margin: 0 0 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .row { display: flex; gap: 6px; }
      .btn { font-size: 11.5px; padding: 5px 10px; border: 1px solid ${buttonBorder}; border-radius: 7px; background: none; color: ${textPrimary}; cursor: pointer; }
      .btn:hover { border-color: ${accent}; }
      .fbadge { font-size: 9px; font-weight: 700; color: ${accent}; background: rgba(16,185,129,.14); padding: 1px 6px; border-radius: 5px; margin-left: 6px; }
      .explain { border: 1px dashed ${buttonBorder}; border-radius: 8px; padding: 8px 10px; margin: 0 0 10px; font-size: 10.5px; color: ${textMuted}; line-height: 1.75; }
      .explain b { color: ${textPrimary}; font-weight: 700; }
    </style>
    <div class="wrap${celebration ? " cel" : ""}">
      <svg class="peek" viewBox="0 0 64 30" aria-hidden="true">
        <circle cx="32" cy="24" r="15" fill="${ink}"/>
        ${celebration ? (
    // The dry observer's one expression change: eyes curve into a smile.
    `<path d="M22.7 19.6 Q26.5 15.2 30.3 19.6" stroke="${eye}" stroke-width="2.6" fill="none" stroke-linecap="round"/>
        <path d="M33.7 19.6 Q37.5 15.2 41.3 19.6" stroke="${eye}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`
  ) : `<circle cx="26.5" cy="18" r="3.8" fill="${eye}"/>
        <circle cx="37.5" cy="18" r="3.8" fill="${eye}"/>`}
      </svg>
      <div class="card" role="alert">
        <svg class="hands" viewBox="0 0 64 12" aria-hidden="true">
          <rect x="6" y="4" width="11" height="8" rx="4" fill="${ink}"/>
          <rect x="47" y="4" width="11" height="8" rx="4" fill="${ink}"/>
        </svg>
        <div class="top"><span class="brand">Kibitzer${payload.firstRun && !celebration ? '<span class="fbadge">\uCCAB \uD6C8\uC218</span>' : ""}</span><button class="close" title="\uB2EB\uAE30">\u2715</button></div>
        <p class="msg"></p>
        <p class="ctx" hidden></p>
        ${payload.firstRun && !celebration ? `<div class="explain">\uB2F5\uD574 \uC8FC\uC2DC\uBA74 \uB2E4\uC74C \uD310\uC815\uC774 \uB354 \uB611\uB611\uD574\uC838\uC694.<br />
          <b>\uB9D0\uD48D\uC120 \uD074\uB9AD</b> = \uC798 \uC7A1\uC558\uC5B4\uC694 \xB7 <b>\uAD00\uB828 \uC788\uC5B4\uC694</b> = \uC624\uD310 \uC2E0\uACE0<br />
          <b>5\uBD84\uB9CC</b> = \uC7A0\uAE50 \uC26C\uAE30 \xB7 <b>30\uBD84 \uC870\uC6A9\uD788</b> = \uB2F9\uBD84\uAC04 \uCE68\uBB35</div>` : ""}
        ${celebration ? "" : `<div class="row">
          <button class="btn" data-kind="related">\uBAA9\uD45C\uC640 \uAD00\uB828 \uC788\uC5B4\uC694</button>
          <button class="btn" data-kind="break">5\uBD84\uB9CC</button>
          <button class="btn" data-kind="snooze">30\uBD84 \uC870\uC6A9\uD788</button>
        </div>`}
      </div>
    </div>`;
  const wrap = shadow.querySelector(".wrap");
  const messageEl = shadow.querySelector(".msg");
  messageEl.textContent = payload.message;
  const contextEl = shadow.querySelector(".ctx");
  if (payload.contextLabel) {
    contextEl.textContent = payload.contextLabel;
    contextEl.hidden = false;
  }
  let settled = false;
  const settle = (kind) => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    if (!payload.demo) {
      try {
        void chrome.runtime.sendMessage({
          type: "kibitzer:toast-feedback",
          notificationId: payload.notificationId,
          displayToken: payload.displayToken,
          kind
        });
      } catch {
      }
    }
    wrap.classList.add("out");
    window.setTimeout(() => host.remove(), 260);
  };
  const timer = window.setTimeout(() => settle("timeout"), payload.autoDismissMs);
  shadow.querySelectorAll(".btn").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      settle(button.dataset.kind ?? "dismissed");
    });
  });
  shadow.querySelector(".close")?.addEventListener("click", (event) => {
    event.stopPropagation();
    settle("dismissed");
  });
  shadow.querySelector(".card")?.addEventListener("click", () => settle(celebration ? "dismissed" : "accepted"));
  document.documentElement.appendChild(host);
}
