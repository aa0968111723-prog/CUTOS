import {
  buildSemanticContext,
  buildSemanticIndex,
  findHighlights,
  getContextRange,
  inspectScene,
  listSpeakers,
  listTopics,
  searchSemantic,
  searchTranscript,
  type SemanticIndex,
} from "@cutos/semantic";
import type { CutosSemanticContext, HighlightRef, SpeakerRef, TopicRef } from "@cutos/protocol";
import { getRuntime } from "./runtime.js";
import { HttpError } from "./errors.js";

/**
 * Semantic video intelligence service.
 *
 * The index is derived from the canonical transcript that already lives in the
 * project store, cached in-process and keyed by (projectId, mediaChecksum,
 * analysisVersion, sentence count). CUTOS remains the single source of truth:
 * nothing here is a second copy of the transcript, and the cache is rebuilt
 * from the store on a cold start.
 */
interface CacheEntry {
  key: string;
  index: SemanticIndex;
}

const globalRef = globalThis as unknown as { __cutosSemanticCache?: Map<string, CacheEntry> };

function cache(): Map<string, CacheEntry> {
  globalRef.__cutosSemanticCache ??= new Map();
  return globalRef.__cutosSemanticCache;
}

export class TranscriptRequiredError extends HttpError {
  constructor(projectId: string) {
    super(
      409,
      "VALIDATION_FAILED",
      `Project ${projectId} has no transcript yet; run analyze first.`,
    );
    this.name = "TranscriptRequiredError";
  }
}

/** Build (or reuse) the retrieval index for a project. */
export function getSemanticIndex(projectId: string): SemanticIndex {
  const { store } = getRuntime();
  const project = store.requireProject(projectId);
  const analysis = store.loadAnalysis(projectId);
  const transcript = analysis?.transcript;
  if (!analysis || !transcript || transcript.sentences.length === 0) {
    throw new TranscriptRequiredError(projectId);
  }

  const key = [
    projectId,
    analysis.mediaChecksum,
    analysis.analysisVersion,
    transcript.sentences.length,
    analysis.updatedAt,
  ].join(":");

  const cached = cache().get(projectId);
  if (cached?.key === key) return cached.index;

  const index = buildSemanticIndex({
    projectId,
    mediaChecksum: analysis.mediaChecksum,
    analysisVersion: analysis.analysisVersion,
    transcript,
    totalDurationMs: project.source.durationMs,
  });
  cache().set(projectId, { key, index });
  return index;
}

/** Drop a project's cached index (used after re-analysis and on delete). */
export function invalidateSemanticIndex(projectId: string): void {
  cache().delete(projectId);
}

function currentRevision(projectId: string): number {
  const { store } = getRuntime();
  return store.loadTimeline(projectId)?.revision ?? store.requireProject(projectId).timelineRevision;
}

export interface TranscriptPage {
  language: string | null;
  provider: string;
  total: number;
  offset: number;
  truncated: boolean;
  sentences: Array<{
    id: string;
    startMs: number;
    endMs: number;
    speaker: string | null;
    text: string;
  }>;
}

/**
 * Paged transcript access. Deliberately paged: an agent that genuinely needs
 * the full text must ask for it page by page, so the default path can never
 * accidentally ship a 45-minute transcript in one payload.
 */
export function getTranscript(
  projectId: string,
  options: { offset?: number; limit?: number } = {},
): TranscriptPage {
  const index = getSemanticIndex(projectId);
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.min(200, Math.max(1, options.limit ?? 100));
  const page = index.sentences.slice(offset, offset + limit);
  return {
    language: index.language,
    provider: "cutos-analysis",
    total: index.sentences.length,
    offset,
    truncated: offset + page.length < index.sentences.length,
    sentences: page.map((s) => ({
      id: s.id,
      startMs: s.startMs,
      endMs: s.endMs,
      speaker: s.speaker,
      text: s.text,
    })),
  };
}

export interface SearchHit {
  sentenceId: string;
  startMs: number;
  endMs: number;
  speaker: string | null;
  text: string;
  score: number;
}

function toHits(
  results: ReturnType<typeof searchSemantic>,
): SearchHit[] {
  return results.map((hit) => ({
    sentenceId: hit.sentence.id,
    startMs: hit.sentence.startMs,
    endMs: hit.sentence.endMs,
    speaker: hit.sentence.speaker,
    text: hit.sentence.text,
    score: hit.score,
  }));
}

export interface SearchArgs {
  projectId: string;
  query: string;
  limit?: number;
  speaker?: string;
  startMs?: number;
  endMs?: number;
}

export function searchTranscriptLiteral(args: SearchArgs): { hits: SearchHit[]; timelineRevision: number } {
  const index = getSemanticIndex(args.projectId);
  return {
    hits: toHits(searchTranscript(index, args.query, {
      limit: args.limit,
      speaker: args.speaker,
      startMs: args.startMs,
      endMs: args.endMs,
    })),
    timelineRevision: currentRevision(args.projectId),
  };
}

export function searchSemanticRanges(args: SearchArgs): { hits: SearchHit[]; timelineRevision: number } {
  const index = getSemanticIndex(args.projectId);
  return {
    hits: toHits(searchSemantic(index, args.query, {
      limit: args.limit,
      speaker: args.speaker,
      startMs: args.startMs,
      endMs: args.endMs,
    })),
    timelineRevision: currentRevision(args.projectId),
  };
}

export function listProjectSpeakers(projectId: string): { speakers: SpeakerRef[] } {
  return { speakers: listSpeakers(getSemanticIndex(projectId)) };
}

export function listProjectTopics(projectId: string, limit?: number): { topics: TopicRef[] } {
  return { topics: listTopics(getSemanticIndex(projectId), limit ?? 12) };
}

export function findProjectHighlights(args: {
  projectId: string;
  targetDurationMs?: number;
  limit?: number;
  query?: string;
}): { highlights: HighlightRef[]; timelineRevision: number } {
  const index = getSemanticIndex(args.projectId);
  return {
    highlights: findHighlights(index, {
      targetDurationMs: args.targetDurationMs,
      limit: args.limit,
      query: args.query,
    }),
    timelineRevision: currentRevision(args.projectId),
  };
}

export function inspectProjectScene(args: { projectId: string; startMs: number; endMs: number }) {
  return inspectScene(getSemanticIndex(args.projectId), args.startMs, args.endMs);
}

export function getProjectContextRange(args: {
  projectId: string;
  startMs: number;
  endMs: number;
  maxSentences?: number;
  maxChars?: number;
}) {
  return getContextRange(getSemanticIndex(args.projectId), args.startMs, args.endMs, {
    maxSentences: args.maxSentences,
    maxChars: args.maxChars,
  });
}

/**
 * Bounded semantic context — the payload CUTOS hands to AIOS instead of a raw
 * transcript. Retrieval happens here; only what matters crosses the boundary.
 */
export function buildProjectSemanticContext(args: {
  projectId: string;
  query: string;
  requestId: string;
  capability: string;
  maxRanges?: number;
  maxChars?: number;
  targetDurationMs?: number;
}): CutosSemanticContext {
  const index = getSemanticIndex(args.projectId);
  return buildSemanticContext({
    index,
    projectId: args.projectId,
    timelineRevision: currentRevision(args.projectId),
    query: args.query,
    requestId: args.requestId,
    capability: args.capability,
    targetDurationMs: args.targetDurationMs,
    budget: {
      ...(args.maxRanges === undefined ? {} : { maxRanges: args.maxRanges }),
      ...(args.maxChars === undefined ? {} : { maxChars: args.maxChars }),
    },
  });
}
