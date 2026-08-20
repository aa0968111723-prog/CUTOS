import type { HighlightRef } from "@cutos/protocol";
import type { IndexedSentence, SemanticIndex } from "./index-build.js";
import { listTopics } from "./topics.js";

export interface FindHighlightsOptions {
  /** Target clip length; windows are grown/split around it. */
  targetDurationMs?: number;
  limit?: number;
  /** Bias scoring toward sentences matching this query. */
  query?: string;
  minDurationMs?: number;
}

interface Window {
  sentences: IndexedSentence[];
  score: number;
  topicIds: string[];
}

const EXCERPT_MAX = 200;

function excerpt(sentences: IndexedSentence[]): string {
  const joined = sentences.map((s) => s.text).join(" ").trim();
  return joined.length <= EXCERPT_MAX ? joined : `${joined.slice(0, EXCERPT_MAX - 1)}…`;
}

/**
 * Find contiguous, self-contained candidate spans worth keeping.
 *
 * Scoring is a transparent combination of: topical density (how much of the
 * project's vocabulary is concentrated here), information density (distinct
 * high-IDF terms per second), and speech continuity (small inter-sentence
 * gaps). No hidden model judgement — every highlight carries a `reasonCode`
 * that the UI renders in zh-TW.
 */
export function findHighlights(
  index: SemanticIndex,
  options: FindHighlightsOptions = {},
): HighlightRef[] {
  const target = options.targetDurationMs ?? 45_000;
  const minDuration = options.minDurationMs ?? Math.min(8_000, target);
  const limit = options.limit ?? 5;
  if (index.sentences.length === 0) return [];

  const topics = listTopics(index, 20);
  const topicByTerm = new Map(topics.map((topic) => [topic.label, topic]));

  const windows: Window[] = [];
  for (let start = 0; start < index.sentences.length; start += 1) {
    const bucket: IndexedSentence[] = [];
    let durationMs = 0;
    for (let end = start; end < index.sentences.length; end += 1) {
      const sentence = index.sentences[end]!;
      const previous = bucket[bucket.length - 1];
      // A highlight must be continuous speech: a long pause ends the window.
      if (previous && sentence.startMs - previous.endMs > 4_000) break;
      bucket.push(sentence);
      durationMs = sentence.endMs - bucket[0]!.startMs;
      if (durationMs < minDuration) continue;
      windows.push(scoreWindow(index, bucket, topicByTerm, target, options.query));
      if (durationMs >= target * 1.5) break;
    }
  }

  windows.sort((a, b) =>
    b.score - a.score
    || a.sentences[0]!.ordinal - b.sentences[0]!.ordinal);

  // Greedy non-overlapping selection keeps the returned set usable as clips.
  const chosen: Window[] = [];
  for (const window of windows) {
    const startMs = window.sentences[0]!.startMs;
    const endMs = window.sentences[window.sentences.length - 1]!.endMs;
    const overlaps = chosen.some((other) => {
      const otherStart = other.sentences[0]!.startMs;
      const otherEnd = other.sentences[other.sentences.length - 1]!.endMs;
      return startMs < otherEnd && endMs > otherStart;
    });
    if (overlaps) continue;
    chosen.push(window);
    if (chosen.length >= limit) break;
  }

  chosen.sort((a, b) => a.sentences[0]!.startMs - b.sentences[0]!.startMs);
  return chosen.map((window, position) => {
    const first = window.sentences[0]!;
    const last = window.sentences[window.sentences.length - 1]!;
    const speakers = new Set(window.sentences.map((s) => s.speaker));
    return {
      id: `highlight_${position + 1}_${first.id}`,
      startMs: first.startMs,
      endMs: last.endMs,
      score: Number(window.score.toFixed(6)),
      reasonCode: reasonFor(window, options.query),
      topicIds: window.topicIds,
      speaker: speakers.size === 1 ? first.speaker : null,
      excerpt: excerpt(window.sentences),
    } satisfies HighlightRef;
  });
}

function reasonFor(window: Window, query?: string): string {
  if (query) return "matches_request";
  if (window.topicIds.length >= 3) return "topic_dense";
  if (window.sentences.length >= 4) return "sustained_explanation";
  return "information_dense";
}

function scoreWindow(
  index: SemanticIndex,
  sentences: IndexedSentence[],
  topicByTerm: Map<string, { id: string; weight: number }>,
  targetDurationMs: number,
  query?: string,
): Window {
  const durationMs = Math.max(
    1,
    sentences[sentences.length - 1]!.endMs - sentences[0]!.startMs,
  );

  let informationWeight = 0;
  const distinct = new Set<string>();
  const topicIds = new Set<string>();
  for (const sentence of sentences) {
    for (const [token, tf] of sentence.terms) {
      const idf = index.idf.get(token) ?? 0;
      if (idf <= 0) continue;
      informationWeight += (1 + Math.log(tf)) * idf;
      distinct.add(token);
      const topic = topicByTerm.get(token);
      if (topic) topicIds.add(topic.id);
    }
  }

  const seconds = durationMs / 1_000;
  const density = informationWeight / Math.max(1, seconds);
  const distinctness = distinct.size / Math.max(1, sentences.length);
  // Prefer windows close to the requested clip length.
  const lengthFit = 1 - Math.min(1, Math.abs(durationMs - targetDurationMs) / targetDurationMs);

  let queryBoost = 0;
  if (query) {
    const needle = query.toLowerCase();
    const hits = sentences.filter((s) => s.text.toLowerCase().includes(needle)).length;
    queryBoost = hits / sentences.length;
  }

  const speechCoverage =
    sentences.reduce((sum, s) => sum + (s.endMs - s.startMs), 0) / durationMs;

  const score =
    density * 0.45
    + distinctness * 0.15
    + lengthFit * 0.2
    + speechCoverage * 0.1
    + queryBoost * 0.5
    + Math.min(1, topicIds.size / 5) * 0.1;

  return { sentences, score, topicIds: [...topicIds].sort() };
}
