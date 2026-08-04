import React from "react";
import { CursorState } from "../lib/cursor";

/**
 * macOS-style arrow pointer. Coordinates are in LOGICAL desktop space, so this must be
 * rendered inside <MacDesktop>'s scaled container.
 */
export const Cursor: React.FC<{ state: CursorState }> = ({ state }) => {
  if (!state.visible) return null;
  const ring = state.clickAge;
  return (
    <div
      style={{
        position: "absolute",
        left: state.x,
        top: state.y,
        width: 0,
        height: 0,
        zIndex: 200,
        pointerEvents: "none",
      }}
    >
      {ring !== null ? (
        <span
          style={{
            position: "absolute",
            left: -3,
            top: -3,
            width: 6 + ring * 34,
            height: 6 + ring * 34,
            marginLeft: -(ring * 17),
            marginTop: -(ring * 17),
            borderRadius: "50%",
            border: "2px solid rgba(37,99,235,0.9)",
            opacity: 1 - ring,
          }}
        />
      ) : null}
      <svg
        width={21}
        height={30}
        viewBox="0 0 21 30"
        style={{
          display: "block",
          filter: "drop-shadow(0 1.5px 2.5px rgba(0,0,0,0.42))",
          transform: state.pressed ? "scale(0.9)" : "scale(1)",
          transformOrigin: "0 0",
        }}
        aria-hidden
      >
        <path
          d="M1.2 1.1v20.6l5.1-4.9 3.4 7.9 3.9-1.7-3.4-7.8h7.1z"
          fill="#000"
          stroke="#fff"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
};
