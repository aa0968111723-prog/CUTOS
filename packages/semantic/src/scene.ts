import type { IndexedSentence, SemanticIndex } from "./index-build.js";
import { charLength } from "./tokenize.js";

export interface SceneInspection {
  startMs: number;
  endMs: number;
  durationMs: number;
  sentenceCount: number;
  speakers: string[];
  /** Highest-weight terms inside the window. */
  keyTerms: string[];
  speechMs: number;
  silenceMs: number;
  /** Bounded excerpt; never the full transcript for the window. */
  excerpt: string;
  truncated: boolean;
}

const EXCERPT_MAX = 600;

function slice(index: SemanticIndex, startMs: number, endMs: number): IndexedSentence[] {
  return index.sentences.filter((s) => s.endMs > startMs && s.startMs < endMs);
}

/** Structured description of one time window — no media bytes, no full text. */
export function inspectScene(
  index: SemanticIndex,
  startMs: number,
  endMs: number,
): SceneInspection {
  const sentences = slice(index, startMs, endMs);
  const durationMs = Math.max(0, endMs - startMs);
  const speechMs = sentences.reduce(
    (sum, s) => sum + (Math.min(endMs, s.endMs) - Math.max(startMs, s.startMs)),
    0,
  );

  const weights = new Map<string, number>();
  for (const sentence of sentences) {
    for (const [token, tf] of sentence.terms) {
      const idf = index.idf.get(token) ?? 0;
      if (idf <= 0) continue;
      weights.set(token, (weights.get(token) ?? 0) + (1 + Math.log(tf)) * idf);
    }
  }
  const keyTerms = [...weights.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 8)
    .map(([token]) => token);

  const joined = sentences.map((s) => s.text).join(" ").trim();
  const truncated = charLength(joined) > EXCERPT_MAX;

  return {
    startMs,
    endMs,
    durationMs,
    sentenceCount: sentences.length,
    speakers: [...new Set(sentences.map((s) => s.speaker ?? "unknown"))].sort(),
    keyTerms,
    speechMs: Math.max(0, speechMs),
    silenceMs: Math.max(0, durationMs - Math.max(0, speechMs)),
    excerpt: truncated ? `${[...joined].slice(0, EXCERPT_MAX - 1).join("")}…` : joined,
    truncated,
  };
}

export interface ContextRange {
  startMs: number;
  endMs: number;
  sentences: Array<{
    id: string;
    startMs: number;
    endMs: number;
    speaker: string | null;
    text: string;
  }>;
  truncated: boolean;
}

/**
 * Fetch the transcript window around a point, with hard caps. This is the
 * escape hatch an agent uses when a highlight excerpt is not enough — it is
 * still bounded so a 45-minute interview can never be pulled wholesale.
 */
export function getContextRange(
  index: SemanticIndex,
  startMs: number,
  endMs: number,
  options: { maxSentences?: number; maxChars?: number } = {},
): ContextRange {
  const maxSentences = options.maxSentences ?? 40;
  const maxChars = options.maxChars ?? 4_000;
  const all = slice(index, startMs, endMs);
  const out: ContextRange["sentences"] = [];
  let chars = 0;
  let truncated = all.length > maxSentences;
  for (const sentence of all.slice(0, maxSentences)) {
    const length = sentence.charCount;
    if (chars + length > maxChars) {
      truncated = true;
      break;
    }
    chars += length;
    out.push({
      id: sentence.id,
      startMs: sentence.startMs,
      endMs: sentence.endMs,
      speaker: sentence.speaker,
      text: sentence.text,
    });
  }
  return { startMs, endMs, sentences: out, truncated };
}
