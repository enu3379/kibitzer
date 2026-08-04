import React from "react";
import { POPUP, TABSTRIP_H, TOOLBAR_H, WINDOW, popup as V } from "../../theme";
import { caretOn } from "../../lib/typewriter";

/**
 * React port of the action popup.
 *
 * Structure follows showSetup / showActive in apps/extension-next/src/popup/popup.ts;
 * every size and colour comes from the <style> block of its popup.html. The popup has
 * exactly two views — there is no dashboard, no status pill, no session summary, and no
 * per-page verdict card. Settings, persona and the Ollama keys live on a separate options
 * page that this video never opens.
 *
 * The single number is the point: S is a 0–100 focus gauge that drains while attention is
 * off-goal and recovers when it comes back, and the popup re-reads it every 1.5s.
 */

const Ghost: React.FC<{ children: React.ReactNode; pressed?: boolean }> = ({ children, pressed }) => (
  <div
    style={{
      width: "100%",
      boxSizing: "border-box",
      padding: 7,
      marginTop: 8,
      textAlign: "center",
      border: `1px solid ${V.border}`,
      borderRadius: 8,
      background: pressed ? "rgba(136,136,136,0.10)" : "transparent",
      color: V.muted,
      fontSize: 13,
      fontWeight: 600,
      transform: pressed ? "scale(0.99)" : "none",
    }}
  >
    {children}
  </div>
);

/** .hint — 12px grey, or #d1495b when it carries a provider failure. */
const Hint: React.FC<{ children: React.ReactNode; err?: boolean }> = ({ children, err }) => (
  <div style={{ fontSize: 12, color: err ? V.err : V.muted, margin: "6px 0 0", wordBreak: "break-word" }}>{children}</div>
);

/** label + input, as the setup row stacks them. `mins` is the fixed 82px column. */
const Field: React.FC<{
  label: string;
  value: string;
  placeholder: string;
  mins?: boolean;
  caret?: boolean;
}> = ({ label, value, placeholder, mins, caret }) => (
  <div style={{ flex: mins ? "0 0 82px" : 1, fontSize: 13, fontWeight: 600, color: V.muted, marginBottom: 10 }}>
    {label}
    <div
      style={{
        width: "100%",
        boxSizing: "border-box",
        padding: "8px 9px",
        marginTop: 4,
        border: `1px solid ${V.border}`,
        borderRadius: 8,
        background: "transparent",
        color: value ? V.text : V.muted,
        fontSize: 14,
        fontWeight: 500,
        lineHeight: 1.45,
        whiteSpace: "nowrap",
        overflow: "hidden",
      }}
    >
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

export type PopupState =
  /** No goal declared — the only view the extension opens on a cold start. */
  | { kind: "setup"; goal: string; minutes: string; typingGoal?: boolean; startPressed?: boolean }
  /**
   * A goal is set. `s` is the live gauge; `mode` is the judging line, which reads
   * "제목 유사도만 (LLM 꺼짐)" until an Ollama key is saved on the options page.
   */
  | {
      kind: "active";
      s: number;
      goal: string;
      mode: string;
      persona: string;
      warn?: string;
      editPressed?: boolean;
    };

export const PopupBody: React.FC<{ state: PopupState; frame: number }> = ({ state, frame }) => (
  <>
    <h1
      style={{
        fontSize: 13,
        margin: "0 0 12px",
        color: V.muted,
        fontWeight: 700,
        letterSpacing: "0.08em",
      }}
    >
      KIBITZER
    </h1>

    {state.kind === "setup" ? (
      <>
        <div style={{ display: "flex", gap: 8 }}>
          <Field
            label="목표"
            value={state.goal}
            placeholder="예: 논문 정리"
            caret={state.typingGoal && caretOn(frame)}
          />
          <Field label="시간(분)" value={state.minutes} placeholder="60" mins />
        </div>
        <div
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "10px 9px",
            textAlign: "center",
            borderRadius: 8,
            background: state.startPressed ? "#19653f" : V.start,
            color: "#fff",
            fontSize: 15,
            fontWeight: 700,
            transform: state.startPressed ? "scale(0.99)" : "none",
          }}
        >
          시작
        </div>
        <Hint>목표를 선언하면 흐름이 어긋날 때만 조용히 알려드려요.</Hint>
        <Hint>목표에 &quot;알림보기&quot;를 넣으면 토스트가 바로 떠요 (테스트용).</Hint>
        <Ghost>설정 · 말투 · AI 판정 열기</Ghost>
      </>
    ) : (
      <>
        <div style={{ fontSize: 34, fontWeight: 700, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}>
          {state.s}
          <small style={{ fontSize: 14, color: V.muted, fontWeight: 500 }}> / 100 몰입</small>
        </div>
        {/* .goalline b inherits the grey — the goal is bolder than the label, not darker. */}
        <div style={{ margin: "8px 0 4px", color: V.muted, fontSize: 14, wordBreak: "keep-all" }}>
          지금 목표 · <b style={{ color: "inherit", fontWeight: 700 }}>{state.goal}</b>
        </div>
        <div style={{ fontSize: 12, color: V.muted, margin: "0 0 4px" }}>{state.mode}</div>
        <div style={{ fontSize: 12, color: V.muted, margin: "0 0 4px" }}>{state.persona}</div>
        {state.warn ? <Hint err>⚠ {state.warn}</Hint> : null}
        <Ghost pressed={state.editPressed}>목표 변경</Ghost>
        <Ghost>설정 · 말투 · AI 판정</Ghost>
      </>
    )}
  </>
);

/** The popup, anchored under the toolbar where Chrome would render it. */
export const ExtensionPopup: React.FC<{
  state: PopupState;
  frame: number;
  reveal: number;
}> = ({ state, frame, reveal }) => (
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
      fontSize: 14,
      fontWeight: 500,
      lineHeight: 1.45,
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
