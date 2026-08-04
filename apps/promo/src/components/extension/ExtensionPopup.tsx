import React from "react";
import { POPUP, TABSTRIP_H, TOOLBAR_H, WINDOW } from "../../theme";
import { KibitzerLogo } from "../brand/KibitzerLogo";
import { caretOn } from "../../lib/typewriter";

/**
 * React port of the action popup. Structure follows renderSetup / renderDashboard /
 * renderSummary in apps/extension/src/popup/popup.ts; all sizes and colours come from
 * the light-scheme block of apps/extension/src/popup/popup.html.
 */

const V = {
  bg: "#ffffff",
  card: "#f4f4f5",
  text: "#18181b",
  muted: "#71717a",
  border: "#e4e4e7",
  accent: "#2563eb",
  amber: "#d97706",
  greenBg: "#dcfce7",
  greenTx: "#166534",
  blueBg: "#dbeafe",
  blueTx: "#1e40af",
  amberBg: "#fef3c7",
  amberTx: "#92400e",
} as const;

export type PillTone = "green" | "blue" | "amber" | "gray";

const PILL_BG: Record<PillTone, { bg: string; fg: string }> = {
  green: { bg: V.greenBg, fg: V.greenTx },
  blue: { bg: V.blueBg, fg: V.blueTx },
  amber: { bg: V.amberBg, fg: V.amberTx },
  gray: { bg: V.card, fg: V.muted },
};

const Header: React.FC<{ label: string; tone: PillTone }> = ({ label, tone }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
    <span style={{ width: 20, height: 20, borderRadius: 5, overflow: "hidden", display: "block" }}>
      <KibitzerLogo size={20} />
    </span>
    <span style={{ fontWeight: 600, fontSize: 15, flex: 1 }}>Kibitzer</span>
    <span
      style={{
        fontSize: 12,
        padding: "2px 10px",
        borderRadius: 999,
        whiteSpace: "nowrap",
        background: PILL_BG[tone].bg,
        color: PILL_BG[tone].fg,
      }}
    >
      {label}
    </span>
  </div>
);

const Label: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p style={{ fontSize: 12, color: V.muted, margin: "0 0 4px" }}>{children}</p>
);

const Input: React.FC<{ value: string; placeholder: string; focused?: boolean; caret?: boolean }> = ({
  value,
  placeholder,
  focused,
  caret,
}) => (
  <div
    style={{
      width: "100%",
      boxSizing: "border-box",
      padding: "8px 10px",
      marginBottom: 8,
      fontSize: 14,
      lineHeight: 1.45,
      border: `1px solid ${focused ? "transparent" : V.border}`,
      outline: focused ? `2px solid ${V.accent}` : "none",
      outlineOffset: -1,
      borderRadius: 7,
      background: V.bg,
      color: value ? V.text : "#a1a1aa",
      wordBreak: "keep-all",
    }}
  >
    {value || placeholder}
    {caret ? (
      <span style={{ display: "inline-block", width: 1.5, height: 15, background: V.text, marginLeft: 1, verticalAlign: "-3px" }} />
    ) : null}
  </div>
);

const Btn: React.FC<{ children: React.ReactNode; primary?: boolean; pressed?: boolean }> = ({ children, primary, pressed }) => (
  <div
    style={{
      flex: 1,
      textAlign: "center",
      padding: "7px 8px",
      fontSize: 13,
      border: `1px solid ${primary ? V.accent : V.border}`,
      borderRadius: 7,
      background: primary ? (pressed ? "#1d4ed8" : V.accent) : pressed ? V.card : V.bg,
      color: primary ? "#fff" : V.text,
      transform: pressed ? "scale(0.985)" : "none",
    }}
  >
    {children}
  </div>
);

const BtnRow: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ display: "flex", gap: 8 }}>{children}</div>
);

const Row: React.FC<{ k: string; v: string }> = ({ k, v }) => (
  <div
    style={{
      display: "flex",
      justifyContent: "space-between",
      gap: 12,
      padding: "6px 0",
      borderBottom: `1px solid ${V.border}`,
      fontSize: 13,
    }}
  >
    <span style={{ color: V.muted }}>{k}</span>
    <span>{v}</span>
  </div>
);

/** .bar — note the fill is the accent blue, not the emerald brand green. */
const Bar: React.FC<{ pct: number }> = ({ pct }) => (
  <div style={{ height: 6, borderRadius: 3, background: V.card, overflow: "hidden", margin: "4px 0 12px" }}>
    <div style={{ width: `${Math.round(pct * 100)}%`, height: "100%", background: V.accent }} />
  </div>
);

const IconBtnRow: React.FC = () => (
  <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, margin: "-8px 0 6px" }}>
    {["리포트", "탐색 기록", "설정"].map((s) => (
      <span key={s} style={{ color: V.muted, fontSize: 13, padding: "2px 4px" }}>
        {s}
      </span>
    ))}
  </div>
);

/** .page-card — "지금 페이지" with the current belief dot. */
const PageCard: React.FC<{ title: string; host: string; drift: boolean }> = ({ title, host, drift }) => (
  <>
    <Label>지금 페이지 · {host}</Label>
    <div style={{ background: V.card, borderRadius: 8, padding: "9px 10px 10px", marginBottom: 12 }}>
      <p style={{ margin: "0 0 3px", fontSize: 12, color: V.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {title}
      </p>
      <p style={{ margin: 0, fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", flex: "none", background: drift ? V.amber : "#10b981" }} />
        {drift ? "목표와 멀어 보여요" : "목표와 관련 있어 보여요"}
      </p>
    </div>
  </>
);

/** .dots — the consecutive-drift streak meter. */
const StreakDots: React.FC<{ streak: number; threshold: number }> = ({ streak, threshold }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
    {Array.from({ length: threshold }, (_, i) => (
      <span
        key={i}
        style={{
          width: 13,
          height: 13,
          borderRadius: "50%",
          boxSizing: "border-box",
          border: `1.5px solid ${i < streak ? V.amber : V.border}`,
          background: i < streak ? V.amber : "transparent",
        }}
      />
    ))}
    <span style={{ fontSize: 12, color: V.muted, marginLeft: 2 }}>
      {Math.min(streak, threshold)} / {threshold}
    </span>
  </div>
);

export type PopupState =
  | { kind: "setup"; goal: string; budget: string; typingGoal?: boolean; startPressed?: boolean }
  | {
      kind: "dashboard";
      goal: string;
      pillLabel: string;
      pillTone: PillTone;
      pageTitle: string;
      pageHost: string;
      pageDrift: boolean;
      streak: number;
      observations: string;
      relatedRatio: string;
      endPressed?: boolean;
    }
  | { kind: "summary" };

export type SummaryCopy = {
  duration: string;
  observations: string;
  onGoal: string;
  interventions: string;
  topDrift: string;
};

const STREAK_THRESHOLD = 3;

export const PopupBody: React.FC<{ state: PopupState; frame: number; summary: SummaryCopy }> = ({ state, frame, summary }) => {
  if (state.kind === "setup") {
    return (
      <>
        <Header label="목표 없음" tone="amber" />
        <Label>오늘의 목표</Label>
        <Input value={state.goal} placeholder="예: 핀란드 여행 일정 계획하기" focused={state.typingGoal} caret={state.typingGoal && caretOn(frame)} />
        <Label>사용 가능 시간 (선택)</Label>
        <Input value={state.budget} placeholder="예: 120 (분)" />
        <BtnRow>
          <Btn primary pressed={state.startPressed}>
            추적 시작
          </Btn>
        </BtnRow>
      </>
    );
  }

  if (state.kind === "dashboard") {
    return (
      <>
        <Header label={state.pillLabel} tone={state.pillTone} />
        <IconBtnRow />
        <Label>오늘의 목표</Label>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 12 }}>
          <p style={{ flex: 1, margin: 0, fontSize: 14, fontWeight: 500, wordBreak: "keep-all" }}>{state.goal}</p>
          <span style={{ color: V.muted, fontSize: 13, padding: "2px 4px" }}>수정</span>
        </div>
        <PageCard title={state.pageTitle} host={state.pageHost} drift={state.pageDrift} />
        <Label>연속 이탈</Label>
        <StreakDots streak={state.streak} threshold={STREAK_THRESHOLD} />
        <p style={{ fontSize: 12, color: V.muted, margin: "0 0 12px" }}>
          {STREAK_THRESHOLD}회 연속 이탈 시에만 한 번 말을 겁니다.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
          {[
            { k: "관측", v: state.observations },
            { k: "목표 관련", v: state.relatedRatio },
          ].map((c) => (
            <div key={c.k} style={{ background: V.card, borderRadius: 8, padding: "8px 10px" }}>
              <p style={{ fontSize: 12, color: V.muted, margin: 0 }}>{c.k}</p>
              <p style={{ fontSize: 18, fontWeight: 600, margin: "2px 0 0" }}>{c.v}</p>
            </div>
          ))}
        </div>
        <BtnRow>
          <Btn>30분 조용히</Btn>
          <Btn pressed={state.endPressed}>세션 종료</Btn>
        </BtnRow>
      </>
    );
  }

  return (
    <>
      <Header label="세션 종료" tone="gray" />
      <Label>목표 관련 시간</Label>
      <Bar pct={0.71} />
      <div style={{ borderTop: `1px solid ${V.border}`, marginBottom: 12 }}>
        <Row k="세션 시간" v={summary.duration} />
        <Row k="관측" v={summary.observations} />
        <Row k="목표 관련" v={summary.onGoal} />
        <Row k="개입" v={summary.interventions} />
        <Row k="최다 이탈" v={summary.topDrift} />
      </div>
      <BtnRow>
        <Btn primary>새 목표 시작</Btn>
      </BtnRow>
    </>
  );
};

/** The 320px popup, anchored under the toolbar where Chrome would render it. */
export const ExtensionPopup: React.FC<{
  state: PopupState;
  frame: number;
  summary: SummaryCopy;
  reveal: number;
}> = ({ state, frame, summary, reveal }) => (
  <div
    style={{
      position: "absolute",
      top: TABSTRIP_H + TOOLBAR_H + 6,
      left: WINDOW.width - POPUP.right - POPUP.width,
      width: POPUP.width,
      boxSizing: "border-box",
      padding: "14px 16px 16px",
      background: V.bg,
      color: V.text,
      fontSize: 14,
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
    <PopupBody state={state} frame={frame} summary={summary} />
  </div>
);
