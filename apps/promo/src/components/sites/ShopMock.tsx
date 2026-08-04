import React from "react";

/**
 * Generic shopping mall. Icon-only header, invented products.
 *
 * The cart badge is the point: it counts up across the spree, which reads as elapsed
 * time far more concretely than a scroll ever could. Products are deliberately personal
 * consumer goods so the beat cannot be misread as on-goal e-commerce research.
 */

export type Product = {
  name: string;
  brand: string;
  price: string;
  was: string;
  art: string;
  glyph: string;
  slug: string;
};

/** The first seven are the ones that end up in the cart; the rest pad out the listing. */
export const PRODUCTS: readonly Product[] = [
  { name: "에어쿠션 러닝화 3세대", brand: "STRIDE", price: "89,000", was: "129,000", art: "linear-gradient(140deg,#0ea5e9,#4f46e5)", glyph: "👟", slug: "stride-air-3" },
  { name: "노이즈캔슬링 무선 이어버드", brand: "AUDIO/N", price: "119,000", was: "159,000", art: "linear-gradient(140deg,#64748b,#1e293b)", glyph: "🎧", slug: "audio-n-buds-anc" },
  { name: "경량 캠핑 체어 (2color)", brand: "OUTLINE", price: "54,900", was: "72,000", art: "linear-gradient(140deg,#22c55e,#0f766e)", glyph: "🪑", slug: "outline-camp-chair" },
  { name: "이중 진공 보온 텀블러 500ml", brand: "DAYLOOP", price: "27,500", was: "38,000", art: "linear-gradient(140deg,#f59e0b,#dc2626)", glyph: "🥤", slug: "dayloop-tumbler-500" },
  { name: "오버핏 코튼 후디", brand: "PLAINWEAR", price: "45,000", was: "59,000", art: "linear-gradient(140deg,#a855f7,#ec4899)", glyph: "🧥", slug: "plainwear-cotton-hoodie" },
  { name: "접이식 블루투스 키보드", brand: "TYPEBOX", price: "62,000", was: "84,000", art: "linear-gradient(140deg,#14b8a6,#0369a1)", glyph: "⌨️", slug: "typebox-fold-keyboard" },
  { name: "간편 원두 드립백 30개입", brand: "MORNING CO.", price: "18,900", was: "24,000", art: "linear-gradient(140deg,#b45309,#78350f)", glyph: "☕", slug: "morning-co-dripbag-30" },
  { name: "저소음 미니 가습기 4L", brand: "AIRLEAF", price: "39,000", was: "52,000", art: "linear-gradient(140deg,#38bdf8,#0369a1)", glyph: "💧", slug: "airleaf-humidifier-4l" },
  { name: "인체공학 무선 마우스", brand: "TYPEBOX", price: "47,000", was: "61,000", art: "linear-gradient(140deg,#475569,#0f172a)", glyph: "🖱️", slug: "typebox-ergo-mouse" },
  { name: "극세사 워시 담요 (싱글)", brand: "PLAINWEAR", price: "33,000", was: "44,000", art: "linear-gradient(140deg,#fb7185,#9f1239)", glyph: "🧣", slug: "plainwear-wash-blanket" },
];

const CartIcon: React.FC<{ count: number; pulse: number }> = ({ count, pulse }) => (
  <span style={{ position: "relative", display: "block", transform: `scale(${1 + pulse * 0.22})`, transformOrigin: "center" }}>
    <svg width={28} height={28} viewBox="0 0 24 24" aria-hidden>
      <path
        d="M2.5 3.5h2.8l2.4 11.2h9.6l2.2-8H6.4"
        stroke="#1f2937"
        strokeWidth="1.9"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="9.4" cy="19.4" r="1.7" fill="#1f2937" />
      <circle cx="16.6" cy="19.4" r="1.7" fill="#1f2937" />
    </svg>
    {count > 0 ? (
      <span
        style={{
          position: "absolute",
          top: -8,
          right: -11,
          minWidth: 23,
          height: 23,
          padding: "0 6px",
          borderRadius: 999,
          background: "#ef4444",
          color: "#fff",
          fontSize: 14,
          fontWeight: 800,
          display: "grid",
          placeItems: "center",
          boxSizing: "border-box",
          boxShadow: "0 0 0 2.5px #fff, 0 2px 6px rgba(239,68,68,0.45)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {count}
      </span>
    ) : null}
  </span>
);

const Header: React.FC<{ cart: number; pulse: number }> = ({ cart, pulse }) => (
  <div style={{ borderBottom: "1px solid #ececec", background: "#fff", flexShrink: 0 }}>
    <div style={{ height: 50, display: "flex", alignItems: "center", padding: "0 22px", gap: 18 }}>
      {/* icon-only mark */}
      <svg width={26} height={26} viewBox="0 0 28 28" aria-hidden style={{ flexShrink: 0 }}>
        <rect x="1" y="1" width="26" height="26" rx="7" fill="#ff4d4f" />
        <path d="M8 10.5h12l-1.4 8.2H9.4z" fill="#fff" />
        <path d="M11 10.5a3 3 0 0 1 6 0" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      </svg>
      <div
        style={{
          flex: 1,
          maxWidth: 420,
          height: 32,
          borderRadius: 999,
          border: "2px solid #ff4d4f",
          display: "flex",
          alignItems: "center",
          padding: "0 15px",
          fontSize: 12,
          color: "#8c8c8c",
        }}
      >
        오늘의 특가 검색
      </div>
      <div style={{ flex: 1 }} />
      <CartIcon count={cart} pulse={pulse} />
    </div>
    <div style={{ display: "flex", gap: 20, padding: "0 22px 10px", fontSize: 11.5, color: "#595959" }}>
      {["베스트", "신상", "패션", "디지털", "리빙", "식품", "특가"].map((c, i) => (
        <span key={c} style={{ fontWeight: i === 6 ? 700 : 450, color: i === 6 ? "#ff4d4f" : "#595959" }}>
          {c}
        </span>
      ))}
    </div>
  </div>
);

/* ------------------------------------------------------------------ listing */

/** The grid you land on from the portal ad, and scroll before picking anything. */
const ListView: React.FC<{ scroll: number; hot: number | null }> = ({ scroll, hot }) => (
  <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
    <div style={{ padding: "16px 24px", transform: `translateY(${-scroll}px)` }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
        <span style={{ fontSize: 17, fontWeight: 700, color: "#262626" }}>오늘의 특가</span>
        <span style={{ fontSize: 11.5, color: "#8c8c8c" }}>1,284개 상품</span>
        <span style={{ marginLeft: "auto", fontSize: 11.5, color: "#595959" }}>인기순 ▾</span>
      </div>
      <div style={{ fontSize: 11, color: "#ff4d4f", fontWeight: 650, marginBottom: 14 }}>타임특가 · 02:41:08 남음</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 13 }}>
        {PRODUCTS.map((p, i) => (
          <div
            key={p.slug}
            style={{
              border: `1px solid ${hot === i ? "#ff4d4f" : "#f0f0f0"}`,
              borderRadius: 8,
              overflow: "hidden",
              transform: hot === i ? "translateY(-3px)" : "none",
              boxShadow: hot === i ? "0 6px 16px rgba(0,0,0,0.14)" : "none",
            }}
          >
            <div style={{ height: 112, background: p.art, display: "grid", placeItems: "center", fontSize: 40 }}>{p.glyph}</div>
            <div style={{ padding: "8px 9px 10px" }}>
              <div style={{ fontSize: 9.5, color: "#8c8c8c", marginBottom: 2 }}>{p.brand}</div>
              <div
                style={{
                  fontSize: 11,
                  color: "#262626",
                  lineHeight: 1.35,
                  height: 30,
                  overflow: "hidden",
                  wordBreak: "keep-all",
                }}
              >
                {p.name}
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 5, marginTop: 5 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#ff4d4f" }}>31%</span>
                <span style={{ fontSize: 13, fontWeight: 800, color: "#262626" }}>
                  {p.price}
                  <span style={{ fontSize: 10, fontWeight: 500 }}>원</span>
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  </div>
);

/* ------------------------------------------------------------------ detail */

/**
 * "함께 본 상품" — the rail that keeps the spree going.
 *
 * This is the mechanism the whole scene turns on: nobody goes back to a listing page seven
 * times, they take whatever the mall puts next to the thing they just bought. So the loop
 * on screen is product → 장바구니 → rail → product, and the rail is where every hop after
 * the first one starts. Three rows at fixed heights, because the pointer has to be able to
 * hit them from scenes/script.ts by coordinate.
 */
const REC_ROW_H = 84;
const REC_ROW_GAP = 10;

const RecRail: React.FC<{ items: readonly number[]; hot: number | null }> = ({ items, hot }) => (
  <div style={{ width: 236, borderLeft: "1px solid #f0f0f0", padding: "22px 18px", flexShrink: 0 }}>
    <div style={{ fontSize: 12.5, fontWeight: 700, color: "#262626", marginBottom: 12 }}>함께 본 상품</div>
    {items.map((idx, row) => {
      const p = PRODUCTS[idx % PRODUCTS.length];
      const on = hot === row;
      return (
        <div
          key={p.slug}
          style={{
            height: REC_ROW_H,
            marginBottom: REC_ROW_GAP,
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
            gap: 11,
            padding: "0 9px",
            borderRadius: 8,
            border: `1px solid ${on ? "#ff4d4f" : "transparent"}`,
            background: on ? "#fff7f7" : "transparent",
            transform: on ? "translateX(-3px)" : "none",
            boxShadow: on ? "0 5px 14px rgba(0,0,0,0.12)" : "none",
          }}
        >
          <span style={{ width: 58, height: 58, borderRadius: 7, background: p.art, display: "grid", placeItems: "center", fontSize: 27, flexShrink: 0 }}>
            {p.glyph}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 9.5, color: "#8c8c8c", marginBottom: 2 }}>{p.brand}</div>
            <div style={{ fontSize: 10.5, color: "#262626", lineHeight: 1.3, height: 27, overflow: "hidden", wordBreak: "keep-all" }}>
              {p.name}
            </div>
            <div style={{ fontSize: 11.5, fontWeight: 800, color: "#262626", marginTop: 3 }}>
              {p.price}
              <span style={{ fontSize: 9.5, fontWeight: 500 }}>원</span>
            </div>
          </div>
        </div>
      );
    })}
  </div>
);

const ProductDetail: React.FC<{ product: Product; addHot: boolean; rec: readonly number[]; recHot: number | null }> = ({
  product,
  addHot,
  rec,
  recHot,
}) => (
  <div style={{ display: "flex", height: "100%" }}>
    <div style={{ flex: 1, minWidth: 0, display: "flex", gap: 26, padding: "22px 26px" }}>
      <div style={{ width: 300, height: 300, borderRadius: 10, background: product.art, display: "grid", placeItems: "center", fontSize: 92, flexShrink: 0 }}>
        {product.glyph}
      </div>
      <div style={{ flex: 1, minWidth: 0, paddingTop: 6 }}>
        <div style={{ fontSize: 11, color: "#8c8c8c", marginBottom: 6, letterSpacing: "0.6px" }}>{product.brand}</div>
        <div style={{ fontSize: 20, fontWeight: 650, color: "#262626", marginBottom: 14, letterSpacing: "-0.3px", wordBreak: "keep-all" }}>
          {product.name}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
          <span style={{ fontSize: 13, color: "#bfbfbf", textDecoration: "line-through" }}>{product.was}원</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#ff4d4f" }}>31%</span>
        </div>
        <div style={{ fontSize: 28, fontWeight: 800, color: "#262626", marginBottom: 18, letterSpacing: "-1px" }}>
          {product.price}
          <span style={{ fontSize: 17, fontWeight: 600 }}>원</span>
        </div>
        <div style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12, marginBottom: 20 }}>
          {[
            ["배송", "내일(수) 도착 보장"],
            ["적립", "구매 시 890P"],
            ["혜택", "카드 즉시할인 5%"],
          ].map(([k, v]) => (
            <div key={k} style={{ display: "flex", gap: 14, fontSize: 11.5, padding: "5px 0" }}>
              <span style={{ color: "#8c8c8c", width: 40 }}>{k}</span>
              <span style={{ color: "#262626" }}>{v}</span>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <span
            style={{
              padding: "11px 26px",
              borderRadius: 7,
              border: `1.5px solid ${addHot ? "#ff4d4f" : "#d9d9d9"}`,
              background: addHot ? "#fff1f0" : "#fff",
              color: addHot ? "#ff4d4f" : "#262626",
              fontSize: 13,
              fontWeight: 650,
              transform: addHot ? "scale(0.98)" : "none",
            }}
          >
            장바구니
          </span>
          <span style={{ padding: "11px 34px", borderRadius: 7, background: "#ff4d4f", color: "#fff", fontSize: 13, fontWeight: 700 }}>
            바로 구매
          </span>
        </div>
      </div>
    </div>
    <RecRail items={rec} hot={recHot} />
  </div>
);

/* ------------------------------------------------------------------ cart */

const CartView: React.FC<{ items: readonly number[] }> = ({ items }) => {
  const rows = items.map((i) => PRODUCTS[i % PRODUCTS.length]);
  const total = rows.reduce((sum, p) => sum + Number(p.price.replace(/,/g, "")), 0);
  return (
    <div style={{ padding: "18px 26px" }}>
      <div style={{ fontSize: 17, fontWeight: 700, color: "#262626", marginBottom: 14 }}>
        장바구니 <span style={{ color: "#ff4d4f" }}>{rows.length}</span>
      </div>
      <div style={{ border: "1px solid #f0f0f0", borderRadius: 8, overflow: "hidden" }}>
        {rows.map((p) => (
          <div key={p.slug} style={{ display: "flex", alignItems: "center", gap: 13, padding: "9px 14px", borderBottom: "1px solid #f5f5f5" }}>
            <span style={{ width: 20, height: 20, borderRadius: 4, border: "1.5px solid #ff4d4f", background: "#ff4d4f", display: "grid", placeItems: "center", color: "#fff", fontSize: 12, flexShrink: 0 }}>
              ✓
            </span>
            <span style={{ width: 46, height: 46, borderRadius: 6, background: p.art, display: "grid", placeItems: "center", fontSize: 22, flexShrink: 0 }}>
              {p.glyph}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 10, color: "#8c8c8c" }}>{p.brand}</div>
              <div style={{ fontSize: 12, color: "#262626", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#262626", flexShrink: 0 }}>{p.price}원</div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "flex-end", gap: 12, marginTop: 14 }}>
        <span style={{ fontSize: 12.5, color: "#8c8c8c" }}>총 상품금액</span>
        <span style={{ fontSize: 22, fontWeight: 800, color: "#262626", letterSpacing: "-0.5px" }}>
          {total.toLocaleString("en-US")}
          <span style={{ fontSize: 14, fontWeight: 600 }}>원</span>
        </span>
      </div>
    </div>
  );
};

/**
 * Confirmation chip under the cart icon — the "담겼다" the badge alone cannot say.
 *
 * The badge pops and settles in eight frames, which at this tempo is easy to miss; the
 * chip lands in the same corner and holds the claim in words for as long as the pop lasts.
 * Driven by the same 1→0 pulse, so there is nothing extra to schedule.
 */
const AddedChip: React.FC<{ pulse: number }> = ({ pulse }) =>
  pulse <= 0 ? null : (
    <div
      style={{
        position: "absolute",
        top: 12,
        right: 20,
        padding: "7px 14px",
        borderRadius: 8,
        background: "#1f2937",
        color: "#fff",
        fontSize: 11.5,
        fontWeight: 600,
        letterSpacing: "-0.2px",
        opacity: Math.min(1, pulse * 2.4),
        transform: `translateY(${(1 - pulse) * -7}px)`,
        boxShadow: "0 6px 18px rgba(0,0,0,0.22)",
        whiteSpace: "nowrap",
      }}
    >
      장바구니에 담았습니다
    </div>
  );

export const ShopMock: React.FC<{
  view: "list" | "detail" | "cart";
  /** list */
  listScroll?: number;
  listHot?: number | null;
  /** detail */
  productIndex?: number;
  addHot?: boolean;
  /** detail — the 함께 본 상품 rail, and which of its three rows is about to be clicked */
  recItems?: readonly number[];
  recHot?: number | null;
  /** header */
  cartCount: number;
  /** 0→1 pop on the badge when an item lands in the cart. */
  cartPulse?: number;
  /** cart — product indices, in the order they were added */
  cartItems?: readonly number[];
}> = ({
  view,
  listScroll = 0,
  listHot = null,
  productIndex = 0,
  addHot = false,
  recItems = [],
  recHot = null,
  cartCount,
  cartPulse = 0,
  cartItems = [],
}) => (
  <div style={{ position: "absolute", inset: 0, background: "#fff", overflow: "hidden", display: "flex", flexDirection: "column" }}>
    <Header cart={cartCount} pulse={cartPulse} />
    <div style={{ position: "relative", flex: 1, minHeight: 0, overflow: "hidden" }}>
      {view === "list" ? <ListView scroll={listScroll} hot={listHot} /> : null}
      {view === "detail" ? (
        <ProductDetail product={PRODUCTS[productIndex % PRODUCTS.length]} addHot={addHot} rec={recItems} recHot={recHot} />
      ) : null}
      {view === "cart" ? <CartView items={cartItems} /> : null}
      <AddedChip pulse={cartPulse} />
    </div>
  </div>
);
