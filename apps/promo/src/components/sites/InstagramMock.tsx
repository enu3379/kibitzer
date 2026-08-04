import React from "react";

/**
 * Generic photo-and-messaging social app. Icon-only header, invented handles — no real
 * wordmark, logo or person anywhere.
 */

const AVATAR_RINGS = [
  "linear-gradient(135deg,#f9ce34,#ee2a7b,#6228d7)",
  "linear-gradient(135deg,#4f46e5,#0ea5e9)",
  "linear-gradient(135deg,#f97316,#db2777)",
  "linear-gradient(135deg,#10b981,#0f766e)",
  "linear-gradient(135deg,#a855f7,#ec4899)",
  "linear-gradient(135deg,#64748b,#334155)",
  "linear-gradient(135deg,#eab308,#f97316)",
  "linear-gradient(135deg,#06b6d4,#3b82f6)",
];

const Avatar: React.FC<{ i: number; size: number; ring?: boolean }> = ({ i, size, ring = false }) => (
  <span
    style={{
      width: size,
      height: size,
      borderRadius: "50%",
      flexShrink: 0,
      background: AVATAR_RINGS[i % AVATAR_RINGS.length],
      padding: ring ? 2 : 0,
      boxSizing: "border-box",
      display: "block",
    }}
  >
    <span
      style={{
        display: "block",
        width: "100%",
        height: "100%",
        borderRadius: "50%",
        background: AVATAR_RINGS[(i + 3) % AVATAR_RINGS.length],
        border: ring ? "2px solid #fff" : "none",
        boxSizing: "border-box",
      }}
    />
  </span>
);

const CameraIcon: React.FC<{ size?: number }> = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <rect x="2.2" y="2.2" width="19.6" height="19.6" rx="6" stroke="#1f2937" strokeWidth="2" fill="none" />
    <circle cx="12" cy="12" r="5" stroke="#1f2937" strokeWidth="2" fill="none" />
    <circle cx="17.6" cy="6.4" r="1.5" fill="#1f2937" />
  </svg>
);

const Header: React.FC<{ dmBadge?: number }> = ({ dmBadge }) => (
  <div
    style={{
      height: 44,
      borderBottom: "1px solid #dbdbdb",
      display: "flex",
      alignItems: "center",
      padding: "0 18px",
      gap: 16,
      background: "#fff",
      flexShrink: 0,
    }}
  >
    <CameraIcon size={23} />
    <div
      style={{
        width: 190,
        height: 27,
        borderRadius: 8,
        background: "#efefef",
        display: "flex",
        alignItems: "center",
        padding: "0 11px",
        fontSize: 11.5,
        color: "#8e8e8e",
      }}
    >
      검색
    </div>
    <div style={{ flex: 1 }} />
    <div style={{ display: "flex", gap: 16, alignItems: "center", color: "#1f2937" }}>
      <svg width={20} height={20} viewBox="0 0 24 24" aria-hidden>
        <path d="M12 21s-7.5-4.6-9.3-9A5.2 5.2 0 0 1 12 6.6 5.2 5.2 0 0 1 21.3 12c-1.8 4.4-9.3 9-9.3 9z" stroke="currentColor" strokeWidth="1.9" fill="none" strokeLinejoin="round" />
      </svg>
      <span style={{ position: "relative", display: "block" }}>
        <svg width={20} height={20} viewBox="0 0 24 24" aria-hidden>
          <path d="M2.4 12a9.6 9.6 0 1 1 4.4 8.1L2.4 21.6l1.5-4.4A9.5 9.5 0 0 1 2.4 12z" stroke="currentColor" strokeWidth="1.9" fill="none" strokeLinejoin="round" />
        </svg>
        {dmBadge ? (
          <span
            style={{
              position: "absolute",
              top: -6,
              right: -8,
              minWidth: 16,
              height: 16,
              padding: "0 4px",
              borderRadius: 999,
              background: "#ed4956",
              color: "#fff",
              fontSize: 10,
              fontWeight: 700,
              display: "grid",
              placeItems: "center",
              boxSizing: "border-box",
            }}
          >
            {dmBadge}
          </span>
        ) : null}
      </span>
      <Avatar i={1} size={21} />
    </div>
  </div>
);

/* ------------------------------------------------------------------ feed */

const POST = {
  handle: "seoul.frames",
  meta: "2시간 전",
  art: "linear-gradient(140deg,#fb923c 0%,#e11d48 45%,#4c1d95 100%)",
  glyph: "🌆",
  likes: "4,182",
  caption: "golden hour on the bridge again",
};

export const InstagramFeed: React.FC<{ scroll?: number }> = ({ scroll = 0 }) => (
  <div style={{ position: "absolute", inset: 0, background: "#fafafa", display: "flex", flexDirection: "column", overflow: "hidden" }}>
    <Header dmBadge={3} />
    <div style={{ flex: 1, overflow: "hidden" }}>
      <div style={{ display: "flex", justifyContent: "center", gap: 26, padding: "18px 0 0", transform: `translateY(${-scroll}px)` }}>
        <div style={{ width: 420 }}>
          {/* stories */}
          <div style={{ display: "flex", gap: 13, padding: "12px 14px", background: "#fff", border: "1px solid #dbdbdb", borderRadius: 8, marginBottom: 18 }}>
            {Array.from({ length: 7 }, (_, i) => (
              <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5 }}>
                <Avatar i={i} size={48} ring />
                <span style={{ fontSize: 9.5, color: "#262626", width: 48, textAlign: "center", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                  {["mina_", "junh0", "dayoung", "kkotb", "seoul.f", "t.park", "yeon__"][i]}
                </span>
              </div>
            ))}
          </div>

          {/* post */}
          <div style={{ background: "#fff", border: "1px solid #dbdbdb", borderRadius: 8, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "10px 13px" }}>
              <Avatar i={4} size={30} ring />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 650, color: "#262626" }}>{POST.handle}</div>
                <div style={{ fontSize: 10, color: "#8e8e8e" }}>{POST.meta}</div>
              </div>
              <span style={{ color: "#262626", letterSpacing: 1.5, fontSize: 14 }}>···</span>
            </div>
            <div style={{ height: 300, background: POST.art, display: "grid", placeItems: "center", fontSize: 62 }}>{POST.glyph}</div>
            <div style={{ padding: "10px 13px 13px" }}>
              <div style={{ display: "flex", gap: 14, marginBottom: 9, color: "#262626" }}>
                <svg width={22} height={22} viewBox="0 0 24 24" aria-hidden>
                  <path d="M12 21s-7.5-4.6-9.3-9A5.2 5.2 0 0 1 12 6.6 5.2 5.2 0 0 1 21.3 12c-1.8 4.4-9.3 9-9.3 9z" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinejoin="round" />
                </svg>
                <svg width={22} height={22} viewBox="0 0 24 24" aria-hidden>
                  <path d="M2.6 12a9.4 9.4 0 1 1 4.3 7.9L2.6 21.4l1.4-4.3A9.3 9.3 0 0 1 2.6 12z" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinejoin="round" />
                </svg>
                <svg width={22} height={22} viewBox="0 0 24 24" aria-hidden>
                  <path d="M21.4 2.6L10.6 13.4M21.4 2.6l-7 18.4-3.8-7.6-7.6-3.8z" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinejoin="round" />
                </svg>
              </div>
              <div style={{ fontSize: 12, fontWeight: 650, color: "#262626", marginBottom: 4 }}>좋아요 {POST.likes}개</div>
              <div style={{ fontSize: 12, color: "#262626" }}>
                <b style={{ fontWeight: 650 }}>{POST.handle}</b> {POST.caption}
              </div>
            </div>
          </div>
        </div>

        {/* suggestions rail */}
        <div style={{ width: 230, paddingTop: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
            <Avatar i={1} size={42} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 650 }}>jaewon.k</div>
              <div style={{ fontSize: 11, color: "#8e8e8e" }}>재원</div>
            </div>
          </div>
          <div style={{ fontSize: 11.5, fontWeight: 650, color: "#8e8e8e", marginBottom: 11 }}>회원님을 위한 추천</div>
          {["hyejin.log", "studio.namu", "onair_dj", "seorin__", "bkkim"].map((n, i) => (
            <div key={n} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 11 }}>
              <Avatar i={i + 2} size={30} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11.5, fontWeight: 650, color: "#262626" }}>{n}</div>
                <div style={{ fontSize: 10, color: "#8e8e8e" }}>회원님을 팔로우합니다</div>
              </div>
              <span style={{ fontSize: 11, fontWeight: 650, color: "#0095f6" }}>팔로우</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  </div>
);

/* ------------------------------------------------------------------ direct messages */

export type Thread = {
  name: string;
  handle: string;
  preview: string;
  time: string;
  unread?: boolean;
};

export const THREADS: readonly Thread[] = [
  { name: "민아", handle: "mina_", preview: "그래서 걔가 뭐랬는데?", time: "지금", unread: true },
  { name: "준호", handle: "junh0", preview: "ㅋㅋㅋㅋㅋㅋ 진짜?", time: "1분", unread: true },
  { name: "다영", handle: "dayoung", preview: "사진 보냈어 확인해봐", time: "2분", unread: true },
  { name: "스터디 4인방", handle: "3명", preview: "김: 주말에 되는사람~", time: "4분", unread: true },
  { name: "태현", handle: "t.park", preview: "그거 링크 좀", time: "9분" },
  { name: "연서", handle: "yeon__", preview: "나 지금 나감", time: "14분" },
  { name: "혜진", handle: "hyejin.log", preview: "고마워!!", time: "26분" },
  { name: "동아리 단톡", handle: "12명", preview: "박: 공지 확인 부탁드려요", time: "38분" },
];

/** Message log for the open thread. `out` = sent by the user. */
const CHAT: ReadonlyArray<{ out: boolean; text: string }> = [
  { out: false, text: "야 그래서 어제 그거 어떻게 됐어" },
  { out: true, text: "아 그거ㅋㅋ 완전 난리났지" },
  { out: false, text: "헐 뭔데뭔데" },
  { out: true, text: "일단 걔가 먼저 얘기를 꺼냈는데" },
  { out: true, text: "다들 표정이 굳어버림" },
  { out: false, text: "ㅋㅋㅋㅋㅋㅋㅋㅋ 상상된다" },
  { out: false, text: "그래서 걔가 뭐랬는데?" },
  { out: true, text: "그게 진짜 웃긴게" },
];

const Bubble: React.FC<{ out: boolean; text: string }> = ({ out, text }) => (
  <div style={{ display: "flex", justifyContent: out ? "flex-end" : "flex-start", marginBottom: 7 }}>
    <span
      style={{
        maxWidth: "68%",
        padding: "8px 13px",
        borderRadius: 18,
        fontSize: 12,
        lineHeight: 1.45,
        background: out ? "#3797f0" : "#efefef",
        color: out ? "#fff" : "#262626",
        wordBreak: "keep-all",
      }}
    >
      {text}
    </span>
  </div>
);

const TypingDots: React.FC = () => (
  <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 7 }}>
    <span style={{ padding: "10px 14px", borderRadius: 18, background: "#efefef", display: "flex", gap: 4 }}>
      {[0, 1, 2].map((i) => (
        <i key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: "#a8a8a8", opacity: 0.5 + i * 0.25 }} />
      ))}
    </span>
  </div>
);

export const InstagramDM: React.FC<{
  /** Which thread is open. */
  activeThread: number;
  /** How many messages of the log are visible. */
  messages: number;
  typing?: boolean;
  dmBadge?: number;
}> = ({ activeThread, messages, typing = false, dmBadge }) => {
  const shown = CHAT.slice(0, Math.max(0, Math.min(CHAT.length, messages)));
  const thread = THREADS[activeThread % THREADS.length];
  return (
    <div style={{ position: "absolute", inset: 0, background: "#fff", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <Header dmBadge={dmBadge} />
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* thread list */}
        <div style={{ width: 268, borderRight: "1px solid #dbdbdb", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ padding: "13px 16px", fontSize: 13.5, fontWeight: 700, color: "#262626", display: "flex", alignItems: "center" }}>
            jaewon.k
            <span style={{ marginLeft: "auto", fontSize: 16 }}>✎</span>
          </div>
          <div style={{ flex: 1, overflow: "hidden" }}>
            {THREADS.map((t, i) => (
              <div
                key={t.handle}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 11,
                  padding: "9px 16px",
                  background: i === activeThread % THREADS.length ? "#efefef" : "transparent",
                }}
              >
                <Avatar i={i} size={40} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: t.unread ? 700 : 450, color: "#262626" }}>{t.name}</div>
                  <div
                    style={{
                      fontSize: 11,
                      color: t.unread ? "#262626" : "#8e8e8e",
                      fontWeight: t.unread ? 600 : 400,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {t.preview} · {t.time}
                  </div>
                </div>
                {t.unread ? <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#3797f0", flexShrink: 0 }} /> : null}
              </div>
            ))}
          </div>
        </div>

        {/* open conversation */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div style={{ height: 52, borderBottom: "1px solid #dbdbdb", display: "flex", alignItems: "center", gap: 10, padding: "0 18px", flexShrink: 0 }}>
            <Avatar i={activeThread} size={30} />
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 650, color: "#262626" }}>{thread.name}</div>
              <div style={{ fontSize: 10.5, color: "#8e8e8e" }}>활동 중</div>
            </div>
          </div>
          <div style={{ flex: 1, padding: "14px 18px", display: "flex", flexDirection: "column", justifyContent: "flex-end", minHeight: 0 }}>
            {shown.map((m, i) => (
              <Bubble key={i} out={m.out} text={m.text} />
            ))}
            {typing ? <TypingDots /> : null}
          </div>
          <div style={{ padding: "10px 18px 14px", flexShrink: 0 }}>
            <div
              style={{
                height: 38,
                borderRadius: 999,
                border: "1px solid #dbdbdb",
                display: "flex",
                alignItems: "center",
                padding: "0 16px",
                fontSize: 12,
                color: "#8e8e8e",
              }}
            >
              메시지 입력...
              <span style={{ marginLeft: "auto", color: "#3797f0", fontWeight: 650 }}>보내기</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
