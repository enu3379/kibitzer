import React from "react";
import { DocBlock, report } from "../../copy";

/** Writing-app toolbar. No product wordmark — the app's identity lives in the title bar. */
const Toolbar: React.FC = () => (
  <div style={{ background: "#fbfbfc", borderBottom: "1px solid #e5e7eb" }}>
    <div style={{ height: 34, display: "flex", alignItems: "center", padding: "0 16px", gap: 10, fontSize: 11.5, color: "#3c4043" }}>
      {["본문", "Pretendard", "11"].map((s) => (
        <span key={s} style={{ border: "1px solid #e5e7eb", borderRadius: 5, padding: "3px 9px", background: "#fff" }}>
          {s} ▾
        </span>
      ))}
      <span style={{ width: 1, height: 16, background: "#e5e7eb", margin: "0 3px" }} />
      <span style={{ fontWeight: 800 }}>B</span>
      <span style={{ fontStyle: "italic", fontWeight: 600 }}>I</span>
      <span style={{ textDecoration: "underline" }}>U</span>
      <span style={{ width: 1, height: 16, background: "#e5e7eb", margin: "0 3px" }} />
      {[0, 1, 2].map((i) => (
        <span key={i} style={{ display: "flex", flexDirection: "column", gap: 2.5, width: 14 }}>
          {[0, 1, 2].map((j) => (
            <i
              key={j}
              style={{
                height: 1.8,
                background: "#5f6368",
                width: j === 2 && i !== 1 ? "70%" : "100%",
                alignSelf: i === 2 ? "flex-end" : "flex-start",
              }}
            />
          ))}
        </span>
      ))}
      <div style={{ flex: 1 }} />
      <span style={{ color: "#9aa0a6", fontSize: 10.5 }}>모든 변경사항이 저장됨</span>
    </div>
  </div>
);

const Caret: React.FC = () => (
  <span style={{ display: "inline-block", width: 1.6, height: 15, background: "#1f2937", marginLeft: 1, verticalAlign: "-3px" }} />
);

/** Bars for the figure that closes the report. */
const Figure: React.FC<{ caption: string }> = ({ caption }) => (
  <>
    <div
      style={{
        height: 128,
        borderRadius: 6,
        background: "#f1f3f4",
        border: "1px solid #e8eaed",
        display: "flex",
        alignItems: "flex-end",
        gap: 13,
        padding: "14px 18px",
        marginTop: 14,
      }}
    >
      {[0.42, 0.68, 0.55, 0.86, 0.31].map((h, i) => (
        <div key={i} style={{ flex: 1, display: "flex", justifyContent: "center" }}>
          <div style={{ width: "62%", height: 84 * h, background: i === 3 ? "#0f766e" : "#9aa0a6", borderRadius: "2px 2px 0 0" }} />
        </div>
      ))}
    </div>
    <div style={{ fontSize: 10.5, color: "#80868b", marginTop: 7 }}>{caption}</div>
  </>
);

/**
 * A block pasted in from a source page. The provenance line is what sells it as a paste
 * rather than something the writer typed — nobody types a hostname under a quote.
 */
const Pasted: React.FC<{ block: Extract<DocBlock, { t: "quote" }>; flash: number }> = ({ block, flash }) => (
  <div
    style={{
      margin: "12px 0",
      padding: "9px 13px",
      borderLeft: "3px solid #9aa0a6",
      background: flash > 0 ? `rgba(66,133,244,${0.20 * flash})` : "#fafafa",
      borderRadius: "0 4px 4px 0",
      transition: "none",
    }}
  >
    {block.text.split("\n").map((l, i) => (
      <div key={i} style={{ fontSize: 11.5, lineHeight: 1.72, color: "#3c4043", fontVariantNumeric: "tabular-nums" }}>
        {l}
      </div>
    ))}
    <div style={{ fontSize: 9.5, color: "#9aa0a6", marginTop: 4 }}>{block.source}</div>
  </div>
);

/**
 * The document surface. `blocks` is the document as written so far — the last block may
 * be mid-typing, which is why the caret is attached to the end of the list rather than
 * to any particular block.
 */
export const EditorMock: React.FC<{
  blocks: readonly DocBlock[];
  showCaret?: boolean;
  /** 0→1, fades out over the frames right after a paste. */
  pasteFlash?: number;
  scroll?: number;
}> = ({ blocks, showCaret = false, pasteFlash = 0, scroll = 0 }) => {
  const lastIndex = blocks.length - 1;
  return (
    <div style={{ position: "absolute", inset: 0, background: "#eceded", overflow: "hidden" }}>
      <Toolbar />
      <div style={{ position: "absolute", top: 34, left: 0, right: 0, bottom: 0, overflow: "hidden" }}>
        <div
          style={{
            width: 560,
            margin: "16px auto 0",
            minHeight: 800,
            background: "#fff",
            boxShadow: "0 1px 3px rgba(60,64,67,0.18), 0 6px 16px rgba(60,64,67,0.12)",
            padding: "40px 54px",
            transform: `translateY(${-scroll}px)`,
            color: "#202124",
          }}
        >
          <h1 style={{ fontSize: 21, fontWeight: 700, margin: "0 0 5px", letterSpacing: "-0.4px", wordBreak: "keep-all" }}>
            {report.title}
          </h1>
          <div style={{ fontSize: 11.5, color: "#80868b", marginBottom: 20 }}>{report.subtitle}</div>

          {blocks.map((b, i) => {
            const caret = showCaret && i === lastIndex;
            switch (b.t) {
              case "h":
                return (
                  <div
                    key={i}
                    style={{ fontSize: 13.5, lineHeight: 1.9, marginTop: i === 0 ? 0 : 12, color: "#202124", fontWeight: 700, wordBreak: "keep-all" }}
                  >
                    {b.text}
                    {caret ? <Caret /> : null}
                  </div>
                );
              case "p":
                return (
                  <div key={i} style={{ fontSize: 12.5, lineHeight: 1.95, marginTop: 4, color: "#3c4043", wordBreak: "keep-all" }}>
                    {b.text}
                    {caret ? <Caret /> : null}
                  </div>
                );
              case "quote":
                return <Pasted key={i} block={b} flash={i === lastIndex ? pasteFlash : 0} />;
              case "gap":
                return (
                  <div key={i} style={{ fontSize: 12.5, lineHeight: 1.95, minHeight: 24 }}>
                    {caret ? <Caret /> : null}
                  </div>
                );
              case "chart":
                return <Figure key={i} caption={b.caption} />;
            }
          })}
        </div>
      </div>
    </div>
  );
};
