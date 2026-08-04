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
};

export const THREADS: readonly Thread[] = [
  { name: "민아", handle: "mina_", preview: "그래서 걔가 뭐랬는데?", time: "지금" },
  { name: "준호", handle: "junh0", preview: "ㅇㅋㅇㅋ 예약 걸어둘게", time: "1분" },
  { name: "다영", handle: "dayoung", preview: "무조건 들어야 됨 ㅋㅋ", time: "2분" },
  { name: "스터디 4인방", handle: "3명", preview: "김: 주말에 되는사람~", time: "4분" },
  { name: "태현", handle: "t.park", preview: "그거 링크 좀", time: "9분" },
  { name: "연서", handle: "yeon__", preview: "나 지금 나감", time: "14분" },
  { name: "혜진", handle: "hyejin.log", preview: "고마워!!", time: "26분" },
  { name: "동아리 단톡", handle: "12명", preview: "박: 공지 확인 부탁드려요", time: "38분" },
];

export type Msg = { out: boolean; text?: string; link?: { title: string; channel: string } };

/**
 * One log per thread — and the threads are deliberately two different kinds.
 *
 * 민아 (0) is THE conversation: a real back-and-forth that opens the drift, keeps running
 * while the tab is somewhere else, and is still running when the film cuts away from it.
 * That is what actually eats an afternoon — not eight notifications, one friend who is
 * also free right now. Its log is long because the run comes back to it three times.
 *
 * 준호 (1), 다영 (2) and the study group (3) are the other kind: a pile of unread that has
 * been sitting there, read at a glance, one reply out, done. Their logs open on messages
 * that have clearly been waiting, and the only outgoing line is the last one.
 *
 * Thread 2 carries the music link — that is how the video gets to the player without the
 * player itself being a distraction the user went looking for.
 */
export const CHATS: ReadonlyArray<readonly Msg[]> = [
  [
    { out: false, text: "야 그래서 어제 그거 어떻게 됐어" },
    { out: true, text: "아 그거ㅋㅋ 완전 난리났지" },
    { out: false, text: "헐 뭔데뭔데" },
    { out: true, text: "일단 걔가 먼저 얘기를 꺼냈는데" },
    { out: false, text: "응응" },
    { out: true, text: "근데 다들 표정이 굳어버림" },
    { out: false, text: "ㅋㅋㅋㅋㅋㅋㅋㅋ 상상된다" },
    { out: false, text: "그래서 걔가 뭐랬는데?" },
    { out: true, text: "그게 진짜 웃긴게" },
    { out: true, text: "아무 말도 안 하고 그냥 나감" },
    { out: false, text: "ㅋㅋㅋㅋㅋ 미친" },
    { out: false, text: "그래서 지금 어떻게 됐는데" },
    { out: true, text: "몰라 아직 연락도 없어" },
    { out: false, text: "와 진짜 대박이다" },
    { out: false, text: "야 근데 그때 사진 있어?" },
    { out: true, text: "있지 잠깐만" },
    { out: false, text: "빨리빨리" },
    { out: false, text: "아 이거 진짜 못 참겠네ㅋㅋㅋ" },
  ],
  [
    { out: false, text: "형 주말에 시간 됨?" },
    { out: false, text: "토요일 저녁쯤 생각중" },
    { out: false, text: "인원은 넷 정도" },
    { out: false, text: "가능하면 예약 미리 걸어두려고" },
    { out: true, text: "ㅇㅋ 나 됨" },
    { out: false, text: "ㅇㅋㅇㅋ 예약 걸어둘게" },
  ],
  [
    { out: false, text: "이거 봤어??" },
    { out: false, text: "요즘 이것만 들음" },
    { out: true, text: "오 뭔데" },
    { out: false, link: { title: "Paperlight — Neon Alley (Official MV)", channel: "metube.com" } },
    { out: false, text: "무조건 들어야 됨 ㅋㅋ" },
    { out: true, text: "일단 틀어볼게" },
  ],
  [
    { out: false, text: "김: 주말에 되는사람~" },
    { out: false, text: "박: 저는 토요일만 됩니다" },
    { out: false, text: "이: 저도 토요일이요" },
    { out: false, text: "김: 그럼 토요일로 갈까요" },
    { out: false, text: "김: 재원님은요?" },
    { out: true, text: "저도 토요일 됩니다" },
    { out: false, text: "김: ㅇㅋ 그럼 토요일 2시!" },
  ],
];

/** Shared link preview card — the bridge from the thread to the player. */
const LinkCard: React.FC<{ link: NonNullable<Msg["link"]>; hot: boolean }> = ({ link, hot }) => (
  <div
    style={{
      width: 214,
      borderRadius: 14,
      overflow: "hidden",
      border: `1px solid ${hot ? "#3797f0" : "#dbdbdb"}`,
      background: "#fff",
      boxShadow: hot ? "0 4px 14px rgba(55,151,240,0.3)" : "none",
      transform: hot ? "scale(0.985)" : "none",
    }}
  >
    <div style={{ position: "relative", height: 118, background: "linear-gradient(135deg,#7c3aed 0%,#db2777 52%,#0f172a 100%)" }}>
      <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
        <span style={{ width: 38, height: 27, borderRadius: 7, background: "#e0303a", display: "grid", placeItems: "center" }}>
          <span
            style={{
              width: 0,
              height: 0,
              marginLeft: 3,
              borderLeft: "10px solid #fff",
              borderTop: "6.5px solid transparent",
              borderBottom: "6.5px solid transparent",
            }}
          />
        </span>
      </span>
    </div>
    <div style={{ padding: "8px 10px 10px" }}>
      <div style={{ fontSize: 11, lineHeight: 1.35, color: "#262626", fontWeight: 550, wordBreak: "keep-all" }}>{link.title}</div>
      <div style={{ fontSize: 9.5, color: "#8e8e8e", marginTop: 3 }}>{link.channel}</div>
    </div>
  </div>
);

const Bubble: React.FC<{ msg: Msg; linkHot?: boolean }> = ({ msg, linkHot = false }) => (
  <div style={{ display: "flex", justifyContent: msg.out ? "flex-end" : "flex-start", marginBottom: 7 }}>
    {msg.link ? (
      <LinkCard link={msg.link} hot={linkHot} />
    ) : (
      <span
        style={{
          maxWidth: "68%",
          padding: "8px 13px",
          borderRadius: 18,
          fontSize: 12,
          lineHeight: 1.45,
          background: msg.out ? "#3797f0" : "#efefef",
          color: msg.out ? "#fff" : "#262626",
          wordBreak: "keep-all",
        }}
      >
        {msg.text}
      </span>
    )}
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
  /** How many messages of the open thread's log are visible. */
  messages: number;
  typing?: boolean;
  dmBadge?: number;
  /** How many rows in the list currently carry an unread marker (from the top). */
  unreadRows?: number;
  /** A row that just received something — pulses to pull the eye across. */
  flashThread?: number | null;
  /** Text in the compose box, mid-reply. */
  composing?: string;
  /** Highlights the shared link right before it gets clicked. */
  linkHot?: boolean;
}> = ({
  activeThread,
  messages,
  typing = false,
  dmBadge,
  unreadRows = 0,
  flashThread = null,
  composing = "",
  linkHot = false,
}) => {
  const log = CHATS[activeThread % CHATS.length];
  const shown = log.slice(0, Math.max(0, Math.min(log.length, messages)));
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
            {THREADS.map((t, i) => {
              const open = i === activeThread % THREADS.length;
              // An open thread has by definition just been read.
              const unread = !open && i < unreadRows;
              const flash = flashThread === i;
              return (
                <div
                  key={t.handle}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 11,
                    padding: "9px 16px",
                    background: open ? "#efefef" : flash ? "#e8f2fd" : "transparent",
                  }}
                >
                  <Avatar i={i} size={40} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: unread ? 700 : 450, color: "#262626" }}>{t.name}</div>
                    <div
                      style={{
                        fontSize: 11,
                        color: unread ? "#262626" : "#8e8e8e",
                        fontWeight: unread ? 600 : 400,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {t.preview} · {t.time}
                    </div>
                  </div>
                  {unread ? (
                    <span
                      style={{
                        width: flash ? 10 : 8,
                        height: flash ? 10 : 8,
                        borderRadius: "50%",
                        background: "#3797f0",
                        flexShrink: 0,
                        boxShadow: flash ? "0 0 0 4px rgba(55,151,240,0.22)" : "none",
                      }}
                    />
                  ) : null}
                </div>
              );
            })}
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
          {/* Pinned to the bottom and clipped at the top: a log this long has scrolled. */}
          <div
            style={{
              flex: 1,
              padding: "14px 18px",
              display: "flex",
              flexDirection: "column",
              justifyContent: "flex-end",
              minHeight: 0,
              overflow: "hidden",
            }}
          >
            {shown.map((m, i) => (
              <Bubble key={i} msg={m} linkHot={linkHot && Boolean(m.link)} />
            ))}
            {typing ? <TypingDots /> : null}
          </div>
          <div style={{ padding: "10px 18px 14px", flexShrink: 0 }}>
            <div
              style={{
                height: 38,
                borderRadius: 999,
                border: `1px solid ${composing ? "#a8a8a8" : "#dbdbdb"}`,
                display: "flex",
                alignItems: "center",
                padding: "0 16px",
                fontSize: 12,
                color: composing ? "#262626" : "#8e8e8e",
              }}
            >
              {composing || "메시지 입력..."}
              {composing ? (
                <span style={{ display: "inline-block", width: 1.4, height: 13, background: "#262626", marginLeft: 1 }} />
              ) : null}
              <span style={{ marginLeft: "auto", color: composing ? "#0095f6" : "#9fd0f7", fontWeight: 650 }}>보내기</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
