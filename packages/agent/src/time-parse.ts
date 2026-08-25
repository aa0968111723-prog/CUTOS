/**
 * Parse Traditional Chinese (and English) time references into integer
 * milliseconds in the original source timebase.
 *
 * Relative phrases ("這裡", "剛剛", "前面三秒") are returned as unresolved
 * references so the caller can bind them to a validated playhead / last
 * visual observation. The parser never guesses where "here" is.
 */

export type TimeRef =
  | { kind: "absolute"; ms: number; raw: string }
  | { kind: "playhead"; raw: string }
  | { kind: "last"; raw: string }
  | { kind: "relative"; offsetMs: number; raw: string };

export interface PlaybackAnchor {
  /** Validated playhead in source milliseconds. */
  playheadMs: number;
  /** Last grounded observation, if the conversation has one. */
  lastMs?: number;
  sourceDurationMs: number;
}

const CJK_NUMERALS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  兩: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** Parse Arabic or CJK numerals (including 二十五, 十二, 三十). */
export function parseCjkNumber(token: string): number | null {
  const trimmed = token.trim();
  if (!trimmed) return null;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const value = Number.parseFloat(trimmed);
    return Number.isFinite(value) ? value : null;
  }
  if (trimmed === "十") return 10;
  if (trimmed.includes("十")) {
    const parts = trimmed.split("十");
    const left = parts[0] ?? "";
    const right = parts[1] ?? "";
    const tens = left === "" ? 1 : (CJK_NUMERALS[left] ?? null);
    const ones = right === "" ? 0 : (CJK_NUMERALS[right] ?? null);
    if (tens === null || ones === null) return null;
    return tens * 10 + ones;
  }
  if (trimmed.length === 1) return CJK_NUMERALS[trimmed] ?? null;
  return null;
}

function clampMs(ms: number, durationMs: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.min(durationMs, Math.round(ms)));
}

const CLOCK_RE =
  /(?<![0-9:])(?<h>\d{1,2}):(?<m>\d{2})(?::(?<s>\d{2}))?(?:\.(?<frac>\d{1,3}))?(?![0-9])/g;
const SECOND_RE = /(?:第\s*)?(?<n>\d+(?:\.\d+)?)\s*秒/g;
const CJK_SECOND_RE = /(?:第\s*)?(?<n>[零〇一二兩三四五六七八九十]+)\s*秒/g;
const MIN_SEC_RE =
  /(?<min>[零〇一二兩三四五六七八九十]+|\d+)\s*分(?:鐘)?\s*(?:之?\s*(?<half>半)|(?<sec>[零〇一二兩三四五六七八九十]+|\d+)\s*秒?)?/g;
const RELATIVE_BEFORE_RE = /(?:前面|前|往前|倒回)\s*(?<n>[零〇一二兩三四五六七八九十]+|\d+(?:\.\d+)?)\s*秒/g;
const RELATIVE_AFTER_RE = /(?:後面|後|往后|往後|再過)\s*(?<n>[零〇一二兩三四五六七八九十]+|\d+(?:\.\d+)?)\s*秒/g;

function clockToMs(match: RegExpExecArray): number {
  const h = Number.parseInt(match.groups?.h ?? "0", 10);
  const m = Number.parseInt(match.groups?.m ?? "0", 10);
  const s = match.groups?.s != null ? Number.parseInt(match.groups.s, 10) : null;
  const frac = match.groups?.frac;
  let ms = 0;
  if (s === null) {
    // m:ss or mm:ss — first group is minutes, second is seconds.
    ms = h * 60_000 + m * 1000;
  } else {
    ms = h * 3_600_000 + m * 60_000 + s * 1000;
  }
  if (frac) {
    const pad = (frac + "000").slice(0, 3);
    ms += Number.parseInt(pad, 10);
  }
  return ms;
}

function collect(regex: RegExp, text: string, toRef: (m: RegExpExecArray) => TimeRef | null): TimeRef[] {
  const out: TimeRef[] = [];
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const ref = toRef(match);
    if (ref) out.push(ref);
  }
  return out;
}

/**
 * Extract every time reference in `text` without resolving deixis.
 * Duplicate overlapping matches (e.g. "25秒" inside "第25秒") are de-duped
 * by raw-string + kind.
 */
export function parseTimeRefs(text: string): TimeRef[] {
  const refs: TimeRef[] = [];
  const occupied = new Set<string>();
  const add = (ref: TimeRef) => {
    const key = `${ref.kind}:${ref.raw}`;
    if (occupied.has(key)) return;
    occupied.add(key);
    refs.push(ref);
  };

  for (const ref of collect(CLOCK_RE, text, (m) => ({
    kind: "absolute",
    ms: clockToMs(m),
    raw: m[0] ?? "",
  }))) {
    add(ref);
  }

  for (const ref of collect(MIN_SEC_RE, text, (m) => {
    const min = parseCjkNumber(m.groups?.min ?? "");
    if (min === null) return null;
    let ms = Math.round(min * 60_000);
    if (m.groups?.half) ms += 30_000;
    else if (m.groups?.sec) {
      const sec = parseCjkNumber(m.groups.sec);
      if (sec === null) return null;
      ms += Math.round(sec * 1000);
    }
    return { kind: "absolute", ms, raw: m[0] ?? "" };
  })) {
    add(ref);
  }

  for (const ref of collect(RELATIVE_BEFORE_RE, text, (m) => {
    const n = parseCjkNumber(m.groups?.n ?? "");
    if (n === null) return null;
    return { kind: "relative", offsetMs: -Math.round(n * 1000), raw: m[0] ?? "" };
  })) {
    add(ref);
  }

  for (const ref of collect(RELATIVE_AFTER_RE, text, (m) => {
    const n = parseCjkNumber(m.groups?.n ?? "");
    if (n === null) return null;
    return { kind: "relative", offsetMs: Math.round(n * 1000), raw: m[0] ?? "" };
  })) {
    add(ref);
  }

  // Bare "N秒" / "第N秒" — skipped when already captured as part of a larger
  // relative or 分-秒 phrase (the raw string of those includes "秒").
  const skipSeconds = new Set(
    refs.filter((r) => r.raw.includes("秒")).map((r) => r.raw),
  );
  for (const ref of [
    ...collect(SECOND_RE, text, (m) => {
      const n = Number.parseFloat(m.groups?.n ?? "");
      if (!Number.isFinite(n)) return null;
      return { kind: "absolute" as const, ms: Math.round(n * 1000), raw: m[0] ?? "" };
    }),
    ...collect(CJK_SECOND_RE, text, (m) => {
      const n = parseCjkNumber(m.groups?.n ?? "");
      if (n === null) return null;
      return { kind: "absolute" as const, ms: Math.round(n * 1000), raw: m[0] ?? "" };
    }),
  ]) {
    if ([...skipSeconds].some((raw) => raw.includes(ref.raw) && raw !== ref.raw)) continue;
    add(ref);
  }

  if (/(?:這裡|這邊|這幕|這一幕|這個畫面|目前|現在)/.test(text)) {
    add({ kind: "playhead", raw: "這裡" });
  }
  if (/(?:剛剛|剛才|上一幕|剛才那)/.test(text)) {
    add({ kind: "last", raw: "剛剛" });
  }

  return refs;
}

/** Resolve time references against a validated playback anchor. */
export function resolveTimeRefs(refs: TimeRef[], anchor: PlaybackAnchor): number[] {
  const times: number[] = [];
  const seen = new Set<number>();
  const push = (ms: number) => {
    const clamped = clampMs(ms, anchor.sourceDurationMs);
    if (seen.has(clamped)) return;
    seen.add(clamped);
    times.push(clamped);
  };
  for (const ref of refs) {
    switch (ref.kind) {
      case "absolute":
        push(ref.ms);
        break;
      case "playhead":
        push(anchor.playheadMs);
        break;
      case "last":
        push(anchor.lastMs ?? anchor.playheadMs);
        break;
      case "relative":
        push(anchor.playheadMs + ref.offsetMs);
        break;
    }
  }
  return times;
}

/** Format milliseconds as `mm:ss.t` (e.g. `00:25.0`, `00:24.5`). */
export function formatClock(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const minutes = Math.floor(clamped / 60_000);
  const seconds = Math.floor((clamped % 60_000) / 1000);
  const tenths = Math.floor((clamped % 1000) / 100);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

export function formatClockRange(startMs: number, endMs: number): string {
  return `${formatClock(startMs)}–${formatClock(endMs)}`;
}
