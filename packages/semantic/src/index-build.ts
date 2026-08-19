import { createHash } from "node:crypto";
import type { Sentence, Transcript } from "@cutos/media";
import { charLength, tokenize } from "./tokenize.js";

/** Bumped when the index shape or scoring changes; invalidates caches. */
export const SEMANTIC_INDEX_VERSION = 1 as const;

export interface IndexedSentence {
  id: string;
  ordinal: number;
  startMs: number;
  endMs: number;
  text: string;
  speaker: string | null;
  /** token -> term frequency inside this sentence */
  terms: Map<string, number>;
  /** L2 norm of the TF-IDF vector (precomputed for cosine similarity) */
  norm: number;
  charCount: number;
}

export interface SemanticIndex {
  version: typeof SEMANTIC_INDEX_VERSION;
  projectId: string;
  mediaChecksum: string;
  analysisVersion: number;
  language: string | null;
  sentences: IndexedSentence[];
  /** token -> number of sentences containing it */
  documentFrequency: Map<string, number>;
  /** token -> inverse document frequency */
  idf: Map<string, number>;
  totalDurationMs: number;
  /** Stable hash of the indexed content; part of every context provenance. */
  indexHash: string;
}

function computeNorm(terms: Map<string, number>, idf: Map<string, number>): number {
  let sum = 0;
  for (const [token, tf] of terms) {
    const weight = (1 + Math.log(tf)) * (idf.get(token) ?? 0);
    sum += weight * weight;
  }
  return Math.sqrt(sum);
}

/**
 * Build a deterministic TF-IDF retrieval index over a transcript.
 *
 * This is the CUTOS-side "semantic video intelligence" source of truth. It is
 * intentionally offline and reproducible: an AIOS agent asking the same query
 * against the same media + revision must get byte-identical ranges, otherwise
 * the bounded-context `contextHash` in the protocol would be meaningless.
 */
export function buildSemanticIndex(input: {
  projectId: string;
  mediaChecksum: string;
  analysisVersion: number;
  transcript: Transcript;
  totalDurationMs: number;
}): SemanticIndex {
  const sentences: IndexedSentence[] = [];
  const documentFrequency = new Map<string, number>();

  input.transcript.sentences.forEach((sentence: Sentence, ordinal: number) => {
    const terms = new Map<string, number>();
    for (const token of tokenize(sentence.text)) {
      terms.set(token, (terms.get(token) ?? 0) + 1);
    }
    for (const token of terms.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
    sentences.push({
      id: sentence.id,
      ordinal,
      startMs: sentence.startMs,
      endMs: sentence.endMs,
      text: sentence.text,
      speaker: sentence.speaker,
      terms,
      norm: 0,
      charCount: charLength(sentence.text),
    });
  });

  const total = Math.max(1, sentences.length);
  const idf = new Map<string, number>();
  for (const [token, df] of documentFrequency) {
    // Smoothed IDF; never negative, so a term present everywhere contributes ~0.
    idf.set(token, Math.log((total + 1) / (df + 0.5)));
  }
  for (const sentence of sentences) {
    sentence.norm = computeNorm(sentence.terms, idf);
  }

  const hash = createHash("sha256");
  hash.update(`${SEMANTIC_INDEX_VERSION}:${input.mediaChecksum}:${input.analysisVersion}`);
  for (const sentence of sentences) {
    hash.update(`\n${sentence.id}|${sentence.startMs}|${sentence.endMs}|${sentence.speaker ?? ""}|${sentence.text}`);
  }

  return {
    version: SEMANTIC_INDEX_VERSION,
    projectId: input.projectId,
    mediaChecksum: input.mediaChecksum,
    analysisVersion: input.analysisVersion,
    language: input.transcript.language,
    sentences,
    documentFrequency,
    idf,
    totalDurationMs: input.totalDurationMs,
    indexHash: hash.digest("hex"),
  };
}
