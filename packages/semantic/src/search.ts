import type { SemanticIndex, IndexedSentence } from "./index-build.js";
import { tokenize } from "./tokenize.js";

export interface ScoredSentence {
  sentence: IndexedSentence;
  score: number;
}

export interface SearchOptions {
  limit?: number;
  /** Only consider sentences from this speaker. */
  speaker?: string | null;
  /** Restrict to a time window. */
  startMs?: number;
  endMs?: number;
  /** Drop results below this cosine score. */
  minScore?: number;
}

function inWindow(sentence: IndexedSentence, options: SearchOptions): boolean {
  if (options.startMs != null && sentence.endMs <= options.startMs) return false;
  if (options.endMs != null && sentence.startMs >= options.endMs) return false;
  if (options.speaker != null && sentence.speaker !== options.speaker) return false;
  return true;
}

/** Deterministic tie-break: higher score, then earlier in the timeline. */
function rank(a: ScoredSentence, b: ScoredSentence): number {
  return b.score - a.score || a.sentence.ordinal - b.sentence.ordinal;
}

/**
 * Cosine similarity retrieval over the TF-IDF index ("semantic" search in the
 * offline sense: term-weighted meaning overlap, not literal substring match).
 */
export function searchSemantic(
  index: SemanticIndex,
  query: string,
  options: SearchOptions = {},
): ScoredSentence[] {
  const queryTerms = new Map<string, number>();
  for (const token of tokenize(query)) {
    queryTerms.set(token, (queryTerms.get(token) ?? 0) + 1);
  }
  if (queryTerms.size === 0) return [];

  let queryNorm = 0;
  const weighted = new Map<string, number>();
  for (const [token, tf] of queryTerms) {
    const weight = (1 + Math.log(tf)) * (index.idf.get(token) ?? 0);
    if (weight === 0) continue;
    weighted.set(token, weight);
    queryNorm += weight * weight;
  }
  queryNorm = Math.sqrt(queryNorm);
  if (queryNorm === 0) return [];

  const minScore = options.minScore ?? 0.02;
  const results: ScoredSentence[] = [];
  for (const sentence of index.sentences) {
    if (!inWindow(sentence, options)) continue;
    if (sentence.norm === 0) continue;
    let dot = 0;
    for (const [token, queryWeight] of weighted) {
      const tf = sentence.terms.get(token);
      if (!tf) continue;
      dot += queryWeight * (1 + Math.log(tf)) * (index.idf.get(token) ?? 0);
    }
    if (dot <= 0) continue;
    const score = dot / (queryNorm * sentence.norm);
    if (score < minScore) continue;
    results.push({ sentence, score: Number(score.toFixed(6)) });
  }
  results.sort(rank);
  return results.slice(0, options.limit ?? 20);
}

/**
 * Literal transcript search (substring, case-insensitive). Kept separate from
 * {@link searchSemantic}: "find where they literally said X" and "find where
 * they talked about X" are different user intents and different capabilities.
 */
export function searchTranscript(
  index: SemanticIndex,
  query: string,
  options: SearchOptions = {},
): ScoredSentence[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const results: ScoredSentence[] = [];
  for (const sentence of index.sentences) {
    if (!inWindow(sentence, options)) continue;
    const haystack = sentence.text.toLowerCase();
    let occurrences = 0;
    let cursor = haystack.indexOf(needle);
    while (cursor >= 0) {
      occurrences += 1;
      cursor = haystack.indexOf(needle, cursor + needle.length);
    }
    if (occurrences === 0) continue;
    results.push({ sentence, score: occurrences });
  }
  results.sort(rank);
  return results.slice(0, options.limit ?? 20);
}
