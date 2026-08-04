/**
 * Synthesises the input sounds the film types and clicks with.
 *
 * A keystroke is three sounds that arrive together and decay at different speeds, and the
 * ratio between them is the entire character of a keyboard:
 *
 *   TICK  — filtered noise at 1.5–5 kHz, gone in a few milliseconds. The contact itself.
 *           Bright and dominant on a mechanical switch, dull and recessed on a laptop.
 *   BODY  — filtered noise an octave or two down, ~15–30 ms. The keycap and the plate.
 *   THOCK — a damped sine at 90–250 Hz. The bottom-out, i.e. how deep the board feels.
 *   RING  — an optional high damped sine. Only metallic boards have one; it is what makes
 *           a typewriter read as metal rather than as plastic.
 *
 * A mouse click is the same engine with the low end taken away and played twice: the
 * press, then the release 50–80 ms later at about half the level. Rendering only the
 * press is the single thing that makes a synthetic click sound synthetic.
 *
 * Everything is generated rather than sampled so the promo carries no third-party audio,
 * and the same seed always yields byte-identical files — a render that changes because a
 * sound effect was regenerated is a render nobody can review.
 *
 * Usage:
 *   node scripts/make-input-sfx.mjs --audition [--out=DIR]      # previews of all styles
 *   node scripts/make-input-sfx.mjs --key=NAME --click=NAME     # write public/sfx/*.wav
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 44100/16-bit/mono — the format ding.wav and celebrate.wav already use. */
const SR = 44100;
const HERE = dirname(fileURLToPath(import.meta.url));
const SFX_DIR = join(HERE, "..", "public", "sfx");

/* ------------------------------------------------------------------ dsp */

/** mulberry32 — deterministic, so regenerating never changes a byte. */
const mulberry32 = (a) => () => {
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** RBJ biquad band-pass, constant 0 dB peak. */
const bandpass = (x, f0, q) => {
  const w0 = (2 * Math.PI * f0) / SR;
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0;
  const b2 = -alpha / a0;
  const a1 = (-2 * Math.cos(w0)) / a0;
  const a2 = (1 - alpha) / a0;
  const y = new Float64Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const out = b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = out;
    y[i] = out;
  }
  return y;
};

/** One-pole low-pass — the "how shallow is this thing" knob. */
const lowpass = (x, fc) => {
  const a = 1 - Math.exp((-2 * Math.PI * fc) / SR);
  const y = new Float64Array(x.length);
  let z = 0;
  for (let i = 0; i < x.length; i++) {
    z += (x[i] - z) * a;
    y[i] = z;
  }
  return y;
};

/* ------------------------------------------------------------------ ten boards */

/**
 * `gain` is the loudness the style is normalised to, not a mix decision — a linear switch
 * really is quieter than a blue one, and flattening that away would make every option
 * sound like the same board with a different EQ.
 */
const KEYS = {
  /* 1 */ membrane: {
    ko: "얕은 노트북 (버터플라이)",
    len: 0.05, gain: 0.5, lp: 6200,
    tick: { hz: 2100, q: 0.9, tau: 0.0035, gain: 1 },
    body: { hz: 520, q: 0.8, tau: 0.014, gain: 0.55 },
    thock: { hz: 170, tau: 0.018, gain: 0.18 },
  },
  /* 2 */ scissor: {
    ko: "맥 매직키보드 (얕고 또렷)",
    len: 0.055, gain: 0.58, lp: 9500,
    tick: { hz: 3200, q: 1.2, tau: 0.0032, gain: 1 },
    body: { hz: 780, q: 0.9, tau: 0.012, gain: 0.4 },
    thock: { hz: 190, tau: 0.016, gain: 0.16 },
  },
  /* 3 */ thock: {
    ko: "저음 기계식 (묵직한 톡)",
    len: 0.09, gain: 0.62, lp: 4200,
    tick: { hz: 1500, q: 1, tau: 0.005, gain: 0.7 },
    body: { hz: 360, q: 1.1, tau: 0.03, gain: 1 },
    thock: { hz: 105, tau: 0.045, gain: 0.5 },
  },
  /* 4 */ clack: {
    ko: "기계식 청축 (딸깍, 금속 링)",
    len: 0.08, gain: 0.72, lp: 13000,
    tick: { hz: 4200, q: 1.6, tau: 0.0028, gain: 1 },
    body: { hz: 900, q: 1.1, tau: 0.016, gain: 0.5 },
    thock: { hz: 150, tau: 0.022, gain: 0.22 },
    ring: { hz: 3400, tau: 0.02, gain: 0.16 },
  },
  /* 5 */ tactile: {
    ko: "기계식 갈축 (둥근 중음)",
    len: 0.07, gain: 0.62, lp: 7000,
    tick: { hz: 2400, q: 1.1, tau: 0.004, gain: 1 },
    body: { hz: 620, q: 1, tau: 0.022, gain: 0.75 },
    thock: { hz: 140, tau: 0.03, gain: 0.32 },
  },
  /* 6 */ linear: {
    ko: "기계식 적축 (조용, 바닥 치는 소리)",
    len: 0.075, gain: 0.44, lp: 4800,
    tick: { hz: 1800, q: 0.8, tau: 0.0055, gain: 0.55 },
    body: { hz: 430, q: 0.9, tau: 0.026, gain: 1 },
    thock: { hz: 125, tau: 0.036, gain: 0.42 },
  },
  /* 7 */ typewriter: {
    ko: "타자기 (금속 타격)",
    len: 0.13, gain: 0.75, lp: 11000,
    tick: { hz: 3600, q: 1.4, tau: 0.0035, gain: 1 },
    body: { hz: 1150, q: 1.3, tau: 0.02, gain: 0.6 },
    thock: { hz: 165, tau: 0.05, gain: 0.3 },
    ring: { hz: 2450, tau: 0.075, gain: 0.22 },
  },
  /* 8 */ paper: {
    ko: "아주 부드럽게 (거의 안 들리는)",
    len: 0.045, gain: 0.3, lp: 3600,
    tick: { hz: 1300, q: 0.7, tau: 0.0035, gain: 1 },
    body: { hz: 430, q: 0.7, tau: 0.013, gain: 0.5 },
    thock: { hz: 155, tau: 0.014, gain: 0.12 },
  },
  /* 9 */ plastic: {
    ko: "싸구려 멤브레인 (통 울리는)",
    len: 0.075, gain: 0.55, lp: 7500,
    tick: { hz: 2700, q: 2.2, tau: 0.004, gain: 0.85 },
    body: { hz: 1450, q: 3.2, tau: 0.028, gain: 1 },
    thock: { hz: 240, tau: 0.024, gain: 0.2 },
  },
  /* 10 */ blip: {
    ko: "UI 효과음 (실사 아닌 스타일)",
    len: 0.04, gain: 0.5, lp: 9000,
    tick: { hz: 5200, q: 3, tau: 0.0022, gain: 0.5 },
    body: { hz: 2600, q: 4, tau: 0.008, gain: 0.5 },
    thock: { hz: 880, tau: 0.014, gain: 0.55 },
  },
};

/* ------------------------------------------------------------------ ten clicks */

/**
 * `up` is the release: how long after the press, and how loud relative to it. A short,
 * quiet release reads as a light modern mouse; a long, nearly-equal one reads as an old
 * heavy switch. `up: null` is a press with no release at all — only a stylised UI blip
 * gets away with that.
 */
const CLICKS = {
  /* 1 */ trackpad: {
    ko: "맥북 트랙패드 (둔탁한 툭)",
    len: 0.04, gain: 0.42, lp: 4200,
    tick: { hz: 1700, q: 0.9, tau: 0.0026, gain: 1 },
    body: { hz: 620, q: 1, tau: 0.011, gain: 0.6 },
    thock: { hz: 210, tau: 0.012, gain: 0.22 },
    up: { at: 0.062, level: 0.5, warp: 0.86 },
  },
  /* 2 */ mouse: {
    ko: "일반 마우스 (표준 딸깍)",
    len: 0.035, gain: 0.52, lp: 9000,
    tick: { hz: 3100, q: 1.5, tau: 0.002, gain: 1 },
    body: { hz: 1150, q: 1.6, tau: 0.008, gain: 0.5 },
    thock: { hz: 300, tau: 0.009, gain: 0.16 },
    up: { at: 0.058, level: 0.55, warp: 0.82 },
  },
  /* 3 */ snappy: {
    ko: "게이밍 마우스 (가볍고 날카롭게)",
    len: 0.028, gain: 0.55, lp: 13000,
    tick: { hz: 4600, q: 2, tau: 0.0016, gain: 1 },
    body: { hz: 1900, q: 2.2, tau: 0.006, gain: 0.45 },
    thock: { hz: 420, tau: 0.007, gain: 0.12 },
    up: { at: 0.042, level: 0.6, warp: 0.8 },
  },
  /* 4 */ heavy: {
    ko: "묵직한 스위치 (두꺼운 클릭)",
    len: 0.055, gain: 0.62, lp: 6000,
    tick: { hz: 2200, q: 1.2, tau: 0.0032, gain: 1 },
    body: { hz: 700, q: 1.3, tau: 0.018, gain: 0.75 },
    thock: { hz: 180, tau: 0.02, gain: 0.35 },
    up: { at: 0.085, level: 0.7, warp: 0.9 },
  },
  /* 5 */ soft: {
    ko: "아주 조용한 클릭",
    len: 0.03, gain: 0.28, lp: 4000,
    tick: { hz: 1900, q: 1, tau: 0.0022, gain: 1 },
    body: { hz: 750, q: 1, tau: 0.009, gain: 0.5 },
    thock: { hz: 260, tau: 0.008, gain: 0.14 },
    up: { at: 0.055, level: 0.45, warp: 0.85 },
  },
  /* 6 */ tick: {
    ko: "얇은 틱 (거의 점 같은 소리)",
    len: 0.02, gain: 0.46, lp: 15000,
    tick: { hz: 6200, q: 2.6, tau: 0.0012, gain: 1 },
    body: { hz: 2800, q: 3, tau: 0.004, gain: 0.4 },
    thock: { hz: 600, tau: 0.005, gain: 0.1 },
    up: { at: 0.038, level: 0.55, warp: 0.8 },
  },
  /* 7 */ pop: {
    ko: "동글동글한 팝",
    len: 0.045, gain: 0.5, lp: 5200,
    tick: { hz: 2000, q: 2.4, tau: 0.0024, gain: 0.7 },
    body: { hz: 1000, q: 3.4, tau: 0.014, gain: 1 },
    thock: { hz: 340, tau: 0.016, gain: 0.3 },
    up: { at: 0.06, level: 0.45, warp: 0.78 },
  },
  /* 8 */ dome: {
    ko: "돔 스위치 (사무실 마우스)",
    len: 0.05, gain: 0.5, lp: 7000,
    tick: { hz: 2600, q: 1.3, tau: 0.0028, gain: 0.9 },
    body: { hz: 1300, q: 2, tau: 0.015, gain: 1 },
    thock: { hz: 250, tau: 0.014, gain: 0.2 },
    up: { at: 0.07, level: 0.62, warp: 0.88 },
  },
  /* 9 */ camera: {
    ko: "셔터 같은 두 번 소리 (또렷한 딸깍)",
    len: 0.03, gain: 0.6, lp: 12000,
    tick: { hz: 3900, q: 1.8, tau: 0.0018, gain: 1 },
    body: { hz: 1600, q: 2, tau: 0.007, gain: 0.55 },
    thock: { hz: 380, tau: 0.008, gain: 0.15 },
    up: { at: 0.075, level: 0.85, warp: 0.95 },
  },
  /* 10 */ blip: {
    ko: "UI 효과음 (실사 아닌 스타일)",
    len: 0.028, gain: 0.48, lp: 11000,
    tick: { hz: 5600, q: 3.4, tau: 0.0014, gain: 0.5 },
    body: { hz: 3000, q: 4.5, tau: 0.006, gain: 0.5 },
    thock: { hz: 1400, tau: 0.009, gain: 0.5 },
    up: null,
  },
};

/* ------------------------------------------------------------------ one hit */

/**
 * `warp` retunes a style without redesigning it: >1 is a bigger, deeper key. The four
 * per-style variants sit within a few percent of 1 so repeated keys never sound looped,
 * and the wide variant sits well below it because a spacebar is a different key, not the
 * same key played quieter.
 */
const render = (style, seed, warp = 1, level = 1) => {
  const rand = mulberry32(seed);
  const n = Math.round(SR * style.len * (0.85 + 0.3 * warp));
  const noise = new Float64Array(n);
  for (let i = 0; i < n; i++) noise[i] = rand() * 2 - 1;

  const layers = [
    [bandpass(noise, style.tick.hz / warp, style.tick.q), style.tick.tau * warp, style.tick.gain],
    [bandpass(noise, style.body.hz / warp, style.body.q), style.body.tau * warp, style.body.gain],
  ];

  let out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    for (const [sig, tau, g] of layers) v += sig[i] * Math.exp(-t / tau) * g;
    v += Math.sin(2 * Math.PI * (style.thock.hz / warp) * t) * Math.exp(-t / (style.thock.tau * warp)) * style.thock.gain;
    if (style.ring) {
      v += Math.sin(2 * Math.PI * (style.ring.hz / warp) * t) * Math.exp(-t / (style.ring.tau * warp)) * style.ring.gain;
    }
    out[i] = v;
  }

  out = lowpass(out, style.lp);

  // A 0.4 ms ramp in and a 4 ms ramp out. Without them the buffer edges are DC steps,
  // which is a different and much worse click than the one being synthesised.
  const rin = Math.round(SR * 0.0004);
  const rout = Math.min(Math.round(SR * 0.004), n - rin - 1);
  for (let i = 0; i < rin; i++) out[i] *= i / rin;
  for (let i = 0; i < rout; i++) out[n - 1 - i] *= i / rout;

  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  const k = peak > 0 ? (style.gain * level) / peak : 0;
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
};

const seedOf = (name) => [...name].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);

/** The five files a keyboard ships as: four keys that differ, and a deeper wide key. */
const keyVariants = (style, name) => {
  const s = seedOf(name);
  return {
    keys: [
      render(style, s + 1, 1.0, 1.0),
      render(style, s + 2, 1.07, 0.92),
      render(style, s + 3, 0.94, 1.0),
      render(style, s + 4, 1.03, 0.88),
    ],
    wide: render(style, s + 5, 1.35, 1.0),
  };
};

/** Press plus release, mixed into one buffer — the film only ever needs a whole click. */
const clickSample = (style, name, seedShift = 0, warp = 1, level = 1) => {
  const s = seedOf(name) + seedShift;
  const down = render(style, s + 1, warp, level);
  if (!style.up) return down;
  const up = render(style, s + 2, warp * style.up.warp, level * style.up.level);
  const at = Math.round(style.up.at * SR);
  const out = new Float64Array(Math.max(down.length, at + up.length));
  out.set(down);
  for (let i = 0; i < up.length; i++) out[at + i] += up[i];
  return out;
};

/** Two variants so a double-click and a rapid sequence never repeat the same file. */
const clickVariants = (style, name) => [clickSample(style, name, 0, 1, 1), clickSample(style, name, 10, 0.95, 0.9)];

/**
 * Shipped files are normalised as a set; auditioned ones are not.
 *
 * The `gain` in a style table is a claim about that board — a linear switch is quieter
 * than a blue one — and while ten styles are being compared that difference is half of
 * what is being judged. Once one is chosen the claim becomes a liability: "paper" would
 * arrive on disk 4 dB below "clack", and the mix level in lib/inputsfx.ts would silently
 * mean something different depending on which style was picked last. So the first variant
 * is normalised to SHIP_PEAK and every other file in the set is scaled by the same
 * factor, which keeps the wide key deeper and the second variant softer while making the
 * set's absolute level a property of the code rather than of the choice.
 */
const SHIP_PEAK = 0.8;

const normalised = (bufs) => {
  let peak = 0;
  for (let i = 0; i < bufs[0].length; i++) peak = Math.max(peak, Math.abs(bufs[0][i]));
  const k = peak > 0 ? SHIP_PEAK / peak : 0;
  return bufs.map((b) => b.map((v) => v * k));
};

/* ------------------------------------------------------------------ wav */

const writeWav = (path, samples) => {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVEfmt ", 8, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  writeFileSync(path, buf);
};

/* ------------------------------------------------------------------ audition */

const mixdown = (hits, tail = 0.35) => {
  const end = Math.max(...hits.map((h) => Math.round(h.at * SR) + h.buf.length)) + Math.round(tail * SR);
  const mix = new Float64Array(end);
  for (const h of hits) {
    const at = Math.round(h.at * SR);
    for (let i = 0; i < h.buf.length; i++) mix[at + i] += h.buf[i] * (h.level ?? 1);
  }
  let peak = 0;
  for (let i = 0; i < end; i++) peak = Math.max(peak, Math.abs(mix[i]));
  if (peak > 0.95) for (let i = 0; i < end; i++) mix[i] *= 0.95 / peak;
  return mix;
};

/**
 * A style is unjudgeable as a single hit — what matters is how twenty of them in a row
 * feel. The audition types the film's own goal string at the rate the goal field uses
 * (~1.55 frames per character at 30 fps), with a human-ish stumble, and marks the word
 * breaks with the wide key.
 */
const PHRASE = "쇼핑 플랫폼의 고객 유인 전략 분석 보고서 작성";

const keyAudition = (style, name) => {
  const v = keyVariants(style, name);
  const rand = mulberry32(99);
  const hits = [];
  let t = 0.3;
  [...PHRASE].forEach((c, i) => {
    hits.push({ at: t, buf: c === " " ? v.wide : v.keys[i % v.keys.length], level: 0.85 + rand() * 0.3 });
    // 0.052 s/char is roughly the film's fastest on-camera rate; the jitter is what stops
    // it sounding like a drum machine.
    t += 0.052 * (0.7 + rand() * 0.9) + (c === " " ? 0.06 : 0);
  });
  return mixdown(hits);
};

/**
 * Clicks are judged by rhythm as much as by timbre, so the audition is the shape the film
 * actually has: a deliberate click, a pause, a second one, then the fast three-in-a-row
 * of the shopping spree, then a double-click.
 */
const CLICK_RHYTHM = [0.3, 0.85, 1.35, 1.55, 1.72, 2.25, 2.37];

const clickAudition = (style, name) => {
  const v = clickVariants(style, name);
  return mixdown(CLICK_RHYTHM.map((at, i) => ({ at, buf: v[i % v.length], level: 1 })));
};

/* ------------------------------------------------------------------ main */

const args = process.argv.slice(2);
const flag = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");

if (args.includes("--audition")) {
  const out = flag("out") ?? join(HERE, "..", "out", "sfx-audition");
  mkdirSync(join(out, "keys"), { recursive: true });
  mkdirSync(join(out, "clicks"), { recursive: true });
  Object.keys(KEYS).forEach((name, i) => {
    const n = String(i + 1).padStart(2, "0");
    writeWav(join(out, "keys", `${n}-${name}.wav`), keyAudition(KEYS[name], name));
    console.log(`key   ${n}  ${name.padEnd(11)} ${KEYS[name].ko}`);
  });
  Object.keys(CLICKS).forEach((name, i) => {
    const n = String(i + 1).padStart(2, "0");
    writeWav(join(out, "clicks", `${n}-${name}.wav`), clickAudition(CLICKS[name], name));
    console.log(`click ${n}  ${name.padEnd(11)} ${CLICKS[name].ko}`);
  });
  console.log(`\n→ ${out}`);
} else {
  const keyName = flag("key");
  const clickName = flag("click");
  if ((!keyName && !clickName) || (keyName && !KEYS[keyName]) || (clickName && !CLICKS[clickName])) {
    console.error(`--key=NAME   one of: ${Object.keys(KEYS).join(", ")}`);
    console.error(`--click=NAME one of: ${Object.keys(CLICKS).join(", ")}`);
    process.exit(1);
  }
  mkdirSync(SFX_DIR, { recursive: true });
  if (keyName) {
    const v = keyVariants(KEYS[keyName], keyName);
    const files = normalised([...v.keys, v.wide]);
    files.slice(0, 4).forEach((s, i) => writeWav(join(SFX_DIR, `key-${i + 1}.wav`), s));
    writeWav(join(SFX_DIR, "key-wide.wav"), files[4]);
    console.log(`key-1..4.wav + key-wide.wav  ←  "${keyName}" (${KEYS[keyName].ko})`);
  }
  if (clickName) {
    normalised(clickVariants(CLICKS[clickName], clickName)).forEach((s, i) =>
      writeWav(join(SFX_DIR, `click-${i + 1}.wav`), s),
    );
    console.log(`click-1..2.wav               ←  "${clickName}" (${CLICKS[clickName].ko})`);
  }
}
