import { createHash } from "node:crypto";
import {
  CUTOS_PROTOCOL_VERSION,
  type CutosSemanticContext,
  type HighlightRef,
  type SpeakerRef,
  type TopicRef,
  type TranscriptRange,
} from "@cutos/protocol";
import type { SemanticIndex } from "./index-build.js";
import { findHighlights } from "./highlights.js";
import { searchSemantic } from "./search.js";
import { listSpeakers, listTopics } from "./topics.js";
import { charLength } from "./tokenize.js";

export interface ContextBudget {
  maxRanges: number;
  maxChars: number;
  maxTopics: number;
  maxSpeakers: number;
  maxHighlights: number;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxRanges: 12,
  maxChars: 6_000,
  maxTopics: 8,
  maxSpeakers: 6,
  maxHighlights: 5,
};

export interface BuildContextInput {
  index: SemanticIndex;
  projectId: string;
  timelineRevision: number;
  query: string;
  requestId: string;
  capability: string;
  budget?: Partial<ContextBudget>;
  /** Merge in ranges the caller already knows about (deduplicated). */
  seedRanges?: TranscriptRange[];
  targetDurationMs?: number;
  now?: () => number;
}

function mergeAdjacent(ranges: TranscriptRange[]): TranscriptRange[] {
  const sorted = [...ranges].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const out: TranscriptRange[] = [];
  for (const range of sorted) {
    const previous = out[out.length - 1];
    // Deduplicate exact repeats and stitch touching/overlapping windows so the
    // same sentence is never sent twice inside one context.
    if (previous && range.startMs <= previous.endMs) {
      const alreadyCovered = range.sentenceIds.every((id) => previous.sentenceIds.includes(id));
      if (alreadyCovered) continue;
      previous.endMs = Math.max(previous.endMs, range.endMs);
      previous.score = Math.max(previous.score, range.score);
      const extraIds = range.sentenceIds.filter((id) => !previous.sentenceIds.includes(id));
      if (extraIds.length) {
        previous.sentenceIds = [...previous.sentenceIds, ...extraIds];
        previous.text = `${previous.text} ${range.text}`.trim();
      }
      if (previous.speaker !== range.speaker) previous.speaker = null;
      continue;
    }
    out.push({ ...range, sentenceIds: [...range.sentenceIds] });
  }
  return out;
}

/**
 * Build the bounded semantic context handed to AIOS.
 *
 * The whole point: AIOS never receives a full 45-minute transcript. CUTOS does
 * retrieval first, then ships only the ranges that matter, with provenance and
 * an explicit budget the caller can see was enforced.
 */
export function buildSemanticContext(input: BuildContextInput): CutosSemanticContext {
  const budget: ContextBudget = { ...DEFAULT_CONTEXT_BUDGET, ...input.budget };
  const now = input.now ?? (() => Date.now());

  const hits = searchSemantic(input.index, input.query, { limit: budget.maxRanges * 2 });
  const candidates: TranscriptRange[] = hits.map((hit) => ({
    startMs: hit.sentence.startMs,
    endMs: hit.sentence.endMs,
    text: hit.sentence.text,
    speaker: hit.sentence.speaker,
    score: hit.score,
    sentenceIds: [hit.sentence.id],
  }));

  const merged = mergeAdjacent([...(input.seedRanges ?? []), ...candidates]);
  // Rank by relevance for truncation, but emit in timeline order: an agent
  // reading the context must see the interview in the order it happened.
  const byScore = [...merged].sort((a, b) => b.score - a.score || a.startMs - b.startMs);

  const kept: TranscriptRange[] = [];
  let usedChars = 0;
  let truncated = merged.length > budget.maxRanges;
  for (const range of byScore) {
    if (kept.length >= budget.maxRanges) {
      truncated = true;
      break;
    }
    const length = charLength(range.text);
    if (usedChars + length > budget.maxChars) {
      truncated = true;
      continue;
    }
    usedChars += length;
    kept.push(range);
  }
  kept.sort((a, b) => a.startMs - b.startMs);

  const topics: TopicRef[] = listTopics(input.index, budget.maxTopics);
  const speakers: SpeakerRef[] = listSpeakers(input.index).slice(0, budget.maxSpeakers);
  const highlights: HighlightRef[] = findHighlights(input.index, {
    limit: budget.maxHighlights,
    query: input.query || undefined,
    targetDurationMs: input.targetDurationMs,
  });

  const contextHash = createHash("sha256")
    .update(input.index.indexHash)
    .update(`|${input.timelineRevision}|${input.query}|${budget.maxRanges}|${budget.maxChars}`)
    .update(kept.map((r) => `${r.startMs}-${r.endMs}`).join(","))
    .digest("hex");

  return {
    protocolVersion: CUTOS_PROTOCOL_VERSION,
    projectId: input.projectId,
    timelineRevision: input.timelineRevision,
    query: input.query,
    topics,
    speakers,
    ranges: kept,
    highlights,
    provenance: {
      capability: input.capability,
      requestId: input.requestId,
      generatedAt: new Date(now()).toISOString(),
      analysisVersion: input.index.analysisVersion,
      mediaChecksum: input.index.mediaChecksum,
      contextHash,
    },
    budget: {
      maxRanges: budget.maxRanges,
      maxChars: budget.maxChars,
      usedRanges: kept.length,
      usedChars,
      truncated,
    },
  };
}
