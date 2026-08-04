import React from "react";
import { mail, report } from "../../copy";

const Sidebar: React.FC = () => (
  <div style={{ width: 148, flexShrink: 0, padding: "12px 10px", borderRight: "1px solid #e5e7eb", background: "#f6f8fc" }}>
    <div style={{ background: "#c2e7ff", color: "#001d35", borderRadius: 14, padding: "9px 14px", fontSize: 12, fontWeight: 600, marginBottom: 14, display: "inline-block" }}>
      ✎ Compose
    </div>
    {[
      ["Inbox", "24"],
      ["Starred", ""],
      ["Sent", ""],
      ["Drafts", "3"],
      ["Archive", ""],
    ].map(([k, n], i) => (
      <div
        key={k}
        style={{
          display: "flex",
          alignItems: "center",
          padding: "6px 11px",
          borderRadius: 999,
          fontSize: 11.5,
          fontWeight: i === 0 ? 700 : 450,
          background: i === 0 ? "#d3e3fd" : "transparent",
          color: "#1f1f1f",
          marginBottom: 1,
        }}
      >
        <span style={{ flex: 1 }}>{k}</span>
        {n ? <span style={{ fontSize: 10.5, fontWeight: 700 }}>{n}</span> : null}
      </div>
    ))}
  </div>
);

const ListRow: React.FC<{ from: string; subject: string; time: string; unread?: boolean }> = ({ from, subject, time, unread }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 14px", borderBottom: "1px solid #f1f3f4", fontSize: 11.5 }}>
    <span style={{ width: 22, height: 22, borderRadius: "50%", background: "#e8eaed", flexShrink: 0 }} />
    <span style={{ width: 116, fontWeight: unread ? 700 : 450, color: "#1f1f1f", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{from}</span>
    <span style={{ flex: 1, color: unread ? "#1f1f1f" : "#5f6368", fontWeight: unread ? 650 : 450, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{subject}</span>
    <span style={{ color: "#5f6368", fontSize: 10.5 }}>{time}</span>
  </div>
);

/**
 * Generic webmail with the compose window open. `sendHot` presses the Send button and
 * `sent` swaps the compose sheet for the confirmation snackbar.
 */
export const MailMock: React.FC<{ reveal: number; sendHot?: boolean; sent?: boolean }> = ({ reveal, sendHot, sent }) => (
  <div style={{ position: "absolute", inset: 0, background: "#fff", overflow: "hidden", display: "flex" }}>
    <Sidebar />
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ height: 40, borderBottom: "1px solid #e5e7eb", display: "flex", alignItems: "center", padding: "0 14px", gap: 12 }}>
        <div style={{ flex: 1, maxWidth: 380, height: 28, background: "#eaf1fb", borderRadius: 999, display: "flex", alignItems: "center", padding: "0 14px", fontSize: 11, color: "#5f6368" }}>
          Search mail
        </div>
      </div>
      {[
        ["Research Desk", "Re: Q3 platform benchmark — data attached", "2:41 PM", true],
        ["Notion", "3 pages were updated in Retail Research", "1:12 PM", false],
        ["Seo-yeon Park", "회의록 공유드립니다", "11:04 AM", false],
        ["MarketPulse", "Your weekly acquisition digest", "9:30 AM", false],
        ["Calendar", "Reminder: Report review, Thursday 4:00 PM", "8:15 AM", false],
      ].map((r) => (
        <ListRow key={r[0] as string} from={r[0] as string} subject={r[1] as string} time={r[2] as string} unread={r[3] as boolean} />
      ))}
    </div>

    {sent ? (
      <div
        style={{
          position: "absolute",
          left: 168,
          bottom: 18,
          background: "#323232",
          color: "#fff",
          borderRadius: 6,
          padding: "11px 18px",
          fontSize: 12,
          boxShadow: "0 4px 14px rgba(0,0,0,0.3)",
          display: "flex",
          gap: 18,
          alignItems: "center",
        }}
      >
        <span>Message sent.</span>
        <span style={{ color: "#8ab4f8", fontWeight: 600 }}>Undo</span>
      </div>
    ) : (
      <div
        style={{
          position: "absolute",
          right: 16,
          bottom: 0,
          width: 460,
          background: "#fff",
          borderRadius: "9px 9px 0 0",
          boxShadow: "0 -2px 10px rgba(0,0,0,0.12), 0 12px 34px rgba(0,0,0,0.28)",
          border: "1px solid #e5e7eb",
          borderBottom: "none",
          transform: `translateY(${(1 - reveal) * 40}px)`,
          opacity: reveal,
          overflow: "hidden",
        }}
      >
        <div style={{ background: "#f2f6fc", padding: "9px 14px", display: "flex", alignItems: "center", fontSize: 11.5, fontWeight: 650, color: "#1f1f1f" }}>
          <span style={{ flex: 1 }}>New Message</span>
          <span style={{ color: "#5f6368", letterSpacing: 3 }}>—▫✕</span>
        </div>
        <div style={{ padding: "0 14px" }}>
          {[
            ["To", mail.to],
            ["Subject", mail.subject],
          ].map(([k, v]) => (
            <div key={k} style={{ display: "flex", gap: 9, padding: "9px 0", borderBottom: "1px solid #f1f3f4", fontSize: 12 }}>
              <span style={{ color: "#5f6368", width: 46, flexShrink: 0 }}>{k}</span>
              <span style={{ color: "#1f1f1f", fontWeight: k === "Subject" ? 600 : 450 }}>{v}</span>
            </div>
          ))}
          <div style={{ padding: "12px 0 8px", fontSize: 12, lineHeight: 1.75, color: "#1f1f1f", minHeight: 96 }}>
            {mail.body.map((l, i) => (l === "" ? <div key={i} style={{ height: 10 }} /> : <div key={i}>{l}</div>))}
          </div>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              border: "1px solid #dadce0",
              borderRadius: 7,
              padding: "6px 11px",
              marginBottom: 12,
              fontSize: 11,
              color: "#3c4043",
              background: "#f8f9fa",
            }}
          >
            <span style={{ width: 17, height: 20, background: "#e8434b", borderRadius: 2, display: "grid", placeItems: "center", color: "#fff", fontSize: 7, fontWeight: 800 }}>
              PDF
            </span>
            <span>{report.fileName}</span>
            <span style={{ color: "#80868b" }}>1.4 MB</span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderTop: "1px solid #f1f3f4" }}>
          <span
            style={{
              background: sendHot ? "#1557b0" : "#0b57d0",
              color: "#fff",
              borderRadius: 999,
              padding: "8px 22px",
              fontSize: 12.5,
              fontWeight: 650,
              transform: sendHot ? "scale(0.97)" : "none",
            }}
          >
            Send
          </span>
          <span style={{ color: "#5f6368", fontSize: 13, letterSpacing: 6 }}>🖇 😊 🖼</span>
        </div>
      </div>
    )}
  </div>
);
