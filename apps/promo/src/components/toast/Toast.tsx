import React from "react";
import { FONT, TOAST, TOAST_SCALE, ext } from "../../theme";

/**
 * React port of the injected overlay in apps/extension/src/content/toastOverlay.ts.
 * Every measurement below is lifted from that file's shadow-root stylesheet (light
 * scheme branch), including the peek/hands SVG geometry — keep them in sync.
 */

const MUTED = "#6b7280"; // textMuted
const TEXT = "#1F2937"; // textPrimary
const BTN_BORDER = "#d1d5db";

/** .peek — sits above the card, margin: 0 0 -6px 18px, viewBox 0 0 64 30 */
const Peek: React.FC<{ smile: boolean; peek: number }> = ({ smile, peek }) => (
  <svg
    viewBox="0 0 64 30"
    width={64}
    style={{ display: "block", margin: "0 0 -6px 18px", transform: `translateY(${(1 - peek) * 16}px)` }}
    aria-hidden
  >
    <circle cx="32" cy="24" r="15" fill={ext.ink} />
    {smile ? (
      <>
        <path d="M22.7 19.6 Q26.5 15.2 30.3 19.6" stroke={ext.offWhite} strokeWidth="2.6" fill="none" strokeLinecap="round" />
        <path d="M33.7 19.6 Q37.5 15.2 41.3 19.6" stroke={ext.offWhite} strokeWidth="2.6" fill="none" strokeLinecap="round" />
      </>
    ) : (
      <>
        <circle cx="26.5" cy="18" r="3.8" fill={ext.offWhite} />
        <circle cx="37.5" cy="18" r="3.8" fill={ext.offWhite} />
      </>
    )}
  </svg>
);

/** .hands — absolute, top -7px, left 18px, viewBox 0 0 64 12 */
const Hands: React.FC = () => (
  <svg viewBox="0 0 64 12" width={64} style={{ position: "absolute", top: -7, left: 18 }} aria-hidden>
    <rect x="6" y="4" width="11" height="8" rx="4" fill={ext.ink} />
    <rect x="47" y="4" width="11" height="8" rx="4" fill={ext.ink} />
  </svg>
);

export type HotButton = "related" | "break" | "snooze" | null;

const BUTTONS: ReadonlyArray<{ kind: Exclude<HotButton, null>; label: string }> = [
  { kind: "related", label: "목표와 관련 있어요" },
  { kind: "break", label: "5분만" },
  { kind: "snooze", label: "30분 조용히" },
];

export const KibitzerToast: React.FC<{
  celebration?: boolean;
  message: string;
  context?: string;
  reveal: number;
  lift: number;
  peek: number;
  hotButton?: HotButton;
  closeHot?: boolean;
}> = ({ celebration = false, message, context, reveal, lift, peek, hotButton = null, closeHot = false }) => {
  const accent = celebration ? ext.sage : ext.emerald;
  return (
    <div
      style={{
        position: "absolute",
        right: TOAST.right,
        bottom: TOAST.bottom,
        width: TOAST.width,
        boxSizing: "border-box",
        fontFamily: FONT,
        // Scale from the anchored corner so the card grows up-and-left out of the same
        // spot the real overlay pins itself to. `lift` rides the scale, as it should.
        transform: `scale(${TOAST_SCALE}) translateY(${lift}px)`,
        transformOrigin: "100% 100%",
        opacity: reveal,
        zIndex: 50,
      }}
    >
      <Peek smile={celebration} peek={peek} />
      <div
        style={{
          position: "relative",
          background: "#ffffff",
          border: `1.5px solid ${accent}`,
          borderRadius: 12,
          padding: "12px 14px",
          boxShadow: "0 6px 24px rgba(0,0,0,.18)",
          boxSizing: "border-box",
        }}
      >
        <Hands />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <span style={{ fontSize: 10.5, color: MUTED }}>Kibitzer</span>
          <span
            title="닫기"
            style={{
              padding: "2px 4px",
              fontSize: 12,
              lineHeight: 1,
              color: closeHot ? TEXT : MUTED,
            }}
          >
            ✕
          </span>
        </div>
        <p style={{ fontSize: 13, lineHeight: 1.55, color: TEXT, margin: `0 0 ${celebration ? 2 : 4}px`, wordBreak: "keep-all" }}>
          {message}
        </p>
        {context ? (
          <p
            style={{
              fontSize: 10.5,
              color: MUTED,
              margin: `0 0 ${celebration ? 2 : 10}px`,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {context}
          </p>
        ) : null}
        {/* Celebrations carry no feedback buttons — the moment should not ask for work. */}
        {celebration ? null : (
          <div style={{ display: "flex", gap: 6 }}>
            {BUTTONS.map((b) => (
              <span
                key={b.kind}
                style={{
                  fontSize: 11.5,
                  padding: "5px 10px",
                  border: `1px solid ${hotButton === b.kind ? accent : BTN_BORDER}`,
                  borderRadius: 7,
                  color: TEXT,
                  whiteSpace: "nowrap",
                  transform: hotButton === b.kind ? "scale(0.98)" : "none",
                }}
              >
                {b.label}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
