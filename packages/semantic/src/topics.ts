import type { TopicRef, SpeakerRef } from "@cutos/protocol";
import type { SemanticIndex } from "./index-build.js";

/**
 * Topic extraction without a model: pick the highest-IDF-weighted terms, then
 * attach each to the time span where it actually occurs. Deterministic and
 * explainable — every topic can be traced back to concrete sentences.
 */
export function listTopics(index: SemanticIndex, limit = 12): TopicRef[] {
  const stats = new Map<string, { weight: number; sentences: number[]; }>();

  for (const sentence of index.sentences) {
    for (const [token, tf] of sentence.terms) {
      const idf = index.idf.get(token) ?? 0;
      // A topic must recur: single-occurrence terms are noise, not topics.
      if ((index.documentFrequency.get(token) ?? 0) < 2) continue;
      const weight = (1 + Math.log(tf)) * idf;
      if (weight <= 0) continue;
      const entry = stats.get(token) ?? { weight: 0, sentences: [] };
      entry.weight += weight;
      entry.sentences.push(sentence.ordinal);
      stats.set(token, entry);
    }
  }

  const ranked = [...stats.entries()]
    .sort((a, b) => b[1].weight - a[1].weight || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit);

  return ranked.map(([label, entry]) => {
    const ordinals = [...new Set(entry.sentences)].sort((a, b) => a - b);
    const first = index.sentences[ordinals[0] ?? 0];
    const last = index.sentences[ordinals[ordinals.length - 1] ?? 0];
    return {
      id: `topic_${label}`,
      label,
      weight: Number(entry.weight.toFixed(4)),
      startMs: first?.startMs ?? 0,
      endMs: last?.endMs ?? 0,
      sentenceCount: ordinals.length,
    } satisfies TopicRef;
  });
}

/** Speaker roster derived from the transcript's diarization labels. */
export function listSpeakers(index: SemanticIndex): SpeakerRef[] {
  const stats = new Map<string, { speakingMs: number; sentenceCount: number }>();
  for (const sentence of index.sentences) {
    const key = sentence.speaker ?? "unknown";
    const entry = stats.get(key) ?? { speakingMs: 0, sentenceCount: 0 };
    entry.speakingMs += Math.max(0, sentence.endMs - sentence.startMs);
    entry.sentenceCount += 1;
    stats.set(key, entry);
  }
  return [...stats.entries()]
    .sort((a, b) => b[1].speakingMs - a[1].speakingMs || (a[0] < b[0] ? -1 : 1))
    .map(([id, entry]) => ({
      id,
      label: id === "unknown" ? "未標記說話者" : id,
      speakingMs: entry.speakingMs,
      sentenceCount: entry.sentenceCount,
    } satisfies SpeakerRef));
}
