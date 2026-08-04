import React from "react";
import { POPUP, POPUP_FONT, TABSTRIP_H, TOOLBAR_H, WINDOW, band, bandOf, popup as V, trackOf } from "../../theme";
import { sundialSVG } from "../../lib/sundial";
import { caretOn } from "../../lib/typewriter";

/**
 * React port of the action popup.
 *
 * Structure follows showSetup / renderActive / showSummary in
 * apps/extension-next/src/popup/popup.ts; every size and colour comes from the <style>
 * block of its popup.html. Three views, and the film visits all three.
 *
 * The two things that carry the product are both here and both are drawings, not numbers:
 * the sundial — a sprout whose shadow swings as the session's budget burns down — and the
 * immersion bar, a 10px track with ticks at the two band boundaries. S is printed beside
 * the bar rather than as a headline, because the bar is what you actually read.
 */

const GHOST: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: 7,
  textAlign: "center",
  border: `1px solid ${V.border}`,
  borderRadius: 8,
  background: "transparent",
  color: V.muted,
  fontWeight: 500,
};

const Ghost: React.FC<{ children: React.ReactNode; danger?: boolean; pressed?: boolean; flex?: boolean }> = ({
  children,
  danger,
  pressed,
  flex,
}) => (
  <div
    style={{
      ...GHOST,
      flex: flex ? 1 : undefined,
      marginTop: flex ? 0 : 8,
      color: danger ? V.err : V.muted,
      borderColor: danger ? "rgba(209,73,91,0.267)" : V.border,
      background: pressed ? "rgba(136,136,136,0.10)" : "transparent",
      transform: pressed ? "scale(0.99)" : "none",
    }}
  >
    {children}
  </div>
);

const Hint: React.FC<{ children: React.ReactNode; err?: boolean }> = ({ children, err }) => (
  <div style={{ fontSize: 11, color: err ? V.err : V.label, margin: "6px 0 0", wordBreak: "break-word" }}>
    {children}
  </div>
);

const CONTROL: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "8px 9px",
  marginTop: 4,
  border: `1px solid ${V.border}`,
  borderRadius: 8,
  background: "transparent",
  fontSize: 14,
  lineHeight: 1.4,
  whiteSpace: "nowrap",
  overflow: "hidden",
};

const Field: React.FC<{ label: string; value: string; placeholder: string; caret?: boolean }> = ({
  label,
  value,
  placeholder,
  caret,
}) => (
  <div style={{ flex: 1, fontSize: 12, color: V.muted, marginBottom: 10 }}>
    {label}
    <div style={{ ...CONTROL, color: value ? V.text : V.label }}>
      {value || placeholder}
      {caret ? (
        <span
          style={{
            display: "inline-block",
            width: 1.5,
            height: 15,
            background: V.text,
            marginLeft: 1,
            verticalAlign: "-3px",
          }}
        />
      ) : null}
    </div>
  </div>
);

/**
 * 사용 시간 — a fixed ladder of durations rather than a free number box, because the value
 * feeds tBudgetSeconds and only a handful of settings behave differently. 108px is the
 * shipping column width: the widest rung ("1시간 30분") plus the chevron needs it.
 *
 * The chevron is painted here for the same reason popup.html paints it: `appearance: none`
 * has to go on to keep Chrome's own arrow from eating the control at this width.
 */
const DurationField: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div style={{ flex: "0 0 108px", fontSize: 12, color: V.muted, marginBottom: 10 }}>
    {label}
    <div style={{ ...CONTROL, color: V.text, paddingRight: 20, position: "relative" }}>
      {value}
      <span
        style={{
          position: "absolute",
          right: 7,
          top: 17,
          width: 0,
          height: 0,
          borderLeft: "4px solid transparent",
          borderRight: "4px solid transparent",
          borderTop: `4px solid ${V.label}`,
        }}
      />
    </div>
  </div>
);

/** .agauge — the immersion bar. Ticks sit at the 33/66 band boundaries. */
const Gauge: React.FC<{ s: number; paused?: boolean }> = ({ s, paused }) => {
  const b = band[bandOf(s, paused)];
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ position: "relative", height: 10, borderRadius: 5, overflow: "hidden", background: trackOf(b.m) }}>
        <div
          style={{
            position: "absolute",
            inset: "0 auto 0 0",
            width: `${s}%`,
            minWidth: 10,
            borderRadius: 5,
            background: b.m,
          }}
        />
        {[33, 66].map((left) => (
          <div
            key={left}
            style={{ position: "absolute", top: 0, bottom: 0, left: `${left}%`, width: 1, background: "rgba(0,0,0,0.18)" }}
          />
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 700 }}>
          <span style={{ color: b.m, marginRight: 4, fontSize: 10 }}>●</span>
          {b.word}
        </span>
        <span style={{ fontSize: 12, color: V.muted, fontVariantNumeric: "tabular-nums" }}>
          <b style={{ fontSize: 15, fontWeight: 700, color: "inherit" }}>{s}</b> / 100
        </span>
      </div>
    </div>
  );
};

/** .meter — the summary's band-coloured bars. Same shape as the gauge, no state word. */
const Meter: React.FC<{ pct: number }> = ({ pct }) => {
  const m = band[bandOf(pct)].m;
  return (
    <div
      style={{
        position: "relative",
        height: 10,
        borderRadius: 5,
        marginTop: 6,
        overflow: "hidden",
        background: trackOf(m),
      }}
    >
      <div style={{ position: "absolute", inset: "0 auto 0 0", width: `${pct}%`, borderRadius: 5, background: m }} />
      {[33, 66].map((left) => (
        <div
          key={left}
          style={{ position: "absolute", top: 2, bottom: 2, left: `${left}%`, width: 1, background: "rgba(0,0,0,0.18)" }}
        />
      ))}
    </div>
  );
};

const Stat: React.FC<{ name: string; value: React.ReactNode; pct?: number }> = ({ name, value, pct }) => (
  <div style={{ marginBottom: 12 }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
      <span style={{ fontSize: 12, color: V.muted }}>{name}</span>
      <span style={{ fontSize: 15, fontWeight: 650, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.01em" }}>
        {value}
      </span>
    </div>
    {pct != null ? <Meter pct={pct} /> : null}
  </div>
);

const Small: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <small style={{ fontSize: 12, fontWeight: 500, color: V.muted }}>{children}</small>
);

export type SummaryCopy = {
  goal: string;
  okPages: string;
  okRatioPct: number;
  validTime: string;
  timePct: number;
  nags: string;
  topTitle: string;
  topMeta: string;
  topOk: boolean;
};

export type PopupState =
  /** No goal declared. Before the first goal is ever set it also carries the 🎯 hint + chips. */
  | { kind: "setup"; goal: string; duration: string; firstRun?: boolean; typingGoal?: boolean; startPressed?: boolean }
  /**
   * A goal is live. `elapsed` is the share of the time budget spent, which is what the
   * sundial draws; past 1.0 the sun sets and the moon takes over at a quarter pace.
   */
  | {
      kind: "active";
      s: number;
      goal: string;
      elapsed: number;
      judgeOn: boolean;
      persona: string;
      paused?: boolean;
      endPressed?: boolean;
    }
  | { kind: "summary"; summary: SummaryCopy };

const CHIPS = ["졸업논문 관련연구 정리", "이력서 포트폴리오 섹션 쓰기", "선형대수 3장 문제풀이"];

const MOON_SLOWDOWN = 4;

export const PopupBody: React.FC<{ state: PopupState; frame: number }> = ({ state, frame }) => (
  <>
    <h1 style={{ fontSize: 12, margin: "0 0 12px", color: V.h1, fontWeight: 600, letterSpacing: "0.06em" }}>
      KIBITZER
    </h1>

    {state.kind === "setup" ? (
      <>
        {state.firstRun ? (
          <>
            {/* .fr-hint — judging accuracy tracks goal specificity, so the first-ever
                setup leads with the ask for a specific goal. */}
            <div
              style={{
                display: "flex",
                gap: 7,
                alignItems: "baseline",
                borderRadius: 8,
                padding: "8px 10px",
                fontSize: 11,
                lineHeight: 1.5,
                marginBottom: 10,
                background: "rgba(30,122,76,0.09)",
                color: "#175f3b",
              }}
            >
              <span>🎯</span>
              <span>
                <b>구체적일수록 판정이 정확해요.</b>
                <br />
                &quot;공부&quot;보다는 &quot;선형대수 3장 문제풀이&quot;. 예시를 눌러 시작해도 좋아요.
              </span>
              <span style={{ marginLeft: "auto", padding: "0 2px" }}>✕</span>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 10 }}>
              {CHIPS.map((c) => (
                <span
                  key={c}
                  style={{
                    color: V.muted,
                    border: `1px solid ${V.border}`,
                    fontSize: 11,
                    fontWeight: 500,
                    padding: "3px 10px",
                    borderRadius: 999,
                  }}
                >
                  {c}
                </span>
              ))}
            </div>
          </>
        ) : null}
        <div style={{ display: "flex", gap: 8 }}>
          <Field label="목표" value={state.goal} placeholder="예: 논문 정리" caret={state.typingGoal && caretOn(frame)} />
          <DurationField label="사용 시간" value={state.duration} />
        </div>
        <div
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: 9,
            textAlign: "center",
            borderRadius: 8,
            background: state.startPressed ? "#19653f" : V.start,
            color: "#fff",
            fontWeight: 600,
            transform: state.startPressed ? "scale(0.99)" : "none",
          }}
        >
          시작
        </div>
        <Hint>목표를 선언하면 흐름이 어긋날 때만 조용히 알려드려요.</Hint>
        <Ghost>설정</Ghost>
      </>
    ) : state.kind === "active" ? (
      <>
        <p style={{ fontSize: 11, color: V.label, margin: 0 }}>현재 목표</p>
        <p style={{ fontSize: 17, fontWeight: 700, lineHeight: 1.3, margin: "2px 0 0", wordBreak: "keep-all" }}>
          {state.goal}
        </p>
        <div
          style={{ display: "flex", justifyContent: "center", margin: "8px 0 2px" }}
          dangerouslySetInnerHTML={{
            __html: sundialSVG(
              state.elapsed > 1 ? Math.min(1, (state.elapsed - 1) / MOON_SLOWDOWN) : state.elapsed,
              state.elapsed > 1,
            ),
          }}
        />
        <Gauge s={state.s} paused={state.paused} />
        <div style={{ fontSize: 11, color: state.judgeOn ? V.judgeOn : V.label, margin: "0 0 4px" }}>
          {state.judgeOn ? "● AI 판정 활성화" : "○ AI 판정 꺼짐 (제목 유사도만)"}
        </div>
        <div style={{ fontSize: 11, color: V.label, margin: "0 0 4px" }}>말투 · {state.persona}</div>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <Ghost flex>목표 변경</Ghost>
          <Ghost flex>{state.paused ? "재개" : "일시정지"}</Ghost>
          <Ghost flex danger pressed={state.endPressed}>
            종료하기
          </Ghost>
        </div>
        <Ghost>설정</Ghost>
      </>
    ) : (
      <>
        <div style={{ fontSize: 11, color: V.label }}>세션 요약</div>
        <div
          style={{
            fontSize: 17,
            fontWeight: 650,
            lineHeight: 1.3,
            margin: "1px 0 14px",
            letterSpacing: "-0.01em",
            wordBreak: "keep-all",
          }}
        >
          {state.summary.goal}
        </div>
        <Stat
          name="유효 페이지 비율"
          value={
            <>
              {state.summary.okPages} <Small>· {state.summary.okRatioPct}%</Small>
            </>
          }
          pct={state.summary.okRatioPct}
        />
        <Stat
          name="유효 방문 시간"
          value={
            <>
              {state.summary.validTime.split(" / ")[0]} <Small>/ {state.summary.validTime.split(" / ")[1]}</Small>
            </>
          }
          pct={state.summary.timePct}
        />
        <Stat name="받은 훈수" value={state.summary.nags} />
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: V.muted }}>가장 오래 머문 페이지</div>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              marginTop: 3,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {state.summary.topTitle}
          </div>
          <div style={{ fontSize: 11, color: V.muted, marginTop: 1, fontVariantNumeric: "tabular-nums" }}>
            <span
              style={{
                display: "inline-block",
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: state.summary.topOk ? band.ok.m : band.bad.m,
                margin: "0 3px 1px 0",
              }}
            />
            {state.summary.topMeta}
          </div>
        </div>
        <hr style={{ border: 0, borderTop: `1px solid ${V.border3}`, margin: "12px 0 0" }} />
        <Ghost>세션 더보기 ▾</Ghost>
        <div
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: 9,
            marginTop: 10,
            textAlign: "center",
            borderRadius: 8,
            background: V.start,
            color: "#fff",
            fontWeight: 600,
          }}
        >
          확인
        </div>
      </>
    )}
  </>
);

/** The popup, anchored under the toolbar where Chrome would render it. */
export const ExtensionPopup: React.FC<{ state: PopupState; frame: number; reveal: number }> = ({
  state,
  frame,
  reveal,
}) => (
  <div
    style={{
      position: "absolute",
      top: TABSTRIP_H + TOOLBAR_H + 6,
      left: WINDOW.width - POPUP.right - POPUP.width,
      width: POPUP.width,
      boxSizing: "border-box",
      padding: POPUP.pad,
      background: V.bg,
      color: V.text,
      font: `14px/1.4 ${POPUP_FONT}`,
      // The sundial reads these off the host, exactly as the popup's :root does.
      ["--sd-ink" as string]: V.sdInk,
      ["--sd-ink3" as string]: V.sdInk3,
      ["--sd-line" as string]: V.sdLine,
      ["--sd-leaf" as string]: V.sdLeaf,
      ["--sd-bg" as string]: V.bg,
      borderRadius: 10,
      border: `1px solid ${V.border}`,
      boxShadow: "0 12px 34px rgba(0,0,0,0.24), 0 2px 8px rgba(0,0,0,0.12)",
      transformOrigin: "top right",
      transform: `translateY(${(1 - reveal) * -8}px) scale(${0.96 + reveal * 0.04})`,
      opacity: reveal,
      zIndex: 60,
    }}
  >
    <PopupBody state={state} frame={frame} />
  </div>
);
