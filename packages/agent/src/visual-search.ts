import type { VisualObservation } from "./chat-response.js";

/**
 * Cached visual segment. Built by sampling frames once, describing them with
 * the vision model, and storing searchable text. Subsequent questions hit this
 * index instead of re-scanning the whole video.
 */
export interface VisualSegment {
  startMs: number;
  endMs: number;
  summary: string;
  objects: string[];
  ocr: string[];
  searchableText: string;
}

export interface VisualIndex {
  projectId: string;
  mediaChecksum: string;
  updatedAt: number;
  segments: VisualSegment[];
}

export interface VisualHit {
  segment: VisualSegment;
  score: number;
}

function ngrams(text: string): string[] {
  const normalized = text.toLowerCase().replace(/\s+/g, "");
  const tokens: string[] = [];
  for (const part of text.toLowerCase().split(/[\s,，。、]+/)) {
    if (part) tokens.push(part);
  }
  for (let i = 0; i < normalized.length - 1; i += 1) {
    const gram = normalized.slice(i, i + 2);
    if (gram.trim().length === 2) tokens.push(gram);
  }
  return tokens;
}

export function searchableFromObservation(observation: VisualObservation): string {
  return [
    observation.description,
    ...observation.objects,
    ...observation.peopleDescriptions,
    ...observation.textSeen,
  ]
    .join(" ")
    .trim();
}

export function segmentFromObservation(observation: VisualObservation): VisualSegment {
  return {
    startMs: observation.startMs,
    endMs: observation.endMs,
    summary: observation.description,
    objects: observation.objects,
    ocr: observation.textSeen,
    searchableText: searchableFromObservation(observation),
  };
}

export function searchVisualIndex(index: VisualIndex, query: string, limit = 8): VisualHit[] {
  const queryTokens = ngrams(query);
  if (queryTokens.length === 0 || index.segments.length === 0) return [];
  const hits: VisualHit[] = [];
  for (const segment of index.segments) {
    const hay = ngrams(segment.searchableText);
    if (hay.length === 0) continue;
    let overlap = 0;
    const haySet = new Set(hay);
    for (const token of queryTokens) {
      if (haySet.has(token)) overlap += 1;
    }
    if (overlap === 0) continue;
    const score = overlap / Math.sqrt(queryTokens.length * haySet.size);
    hits.push({ segment, score });
  }
  hits.sort((a, b) => b.score - a.score || a.segment.startMs - b.segment.startMs);
  return hits.slice(0, limit);
}

export class MemoryVisualIndexStore {
  private readonly byProject = new Map<string, VisualIndex>();

  load(projectId: string, mediaChecksum: string): VisualIndex | undefined {
    const current = this.byProject.get(projectId);
    if (!current || current.mediaChecksum !== mediaChecksum) return undefined;
    return current;
  }

  save(index: VisualIndex): void {
    this.byProject.set(index.projectId, index);
  }

  addSegments(projectId: string, mediaChecksum: string, segments: VisualSegment[]): VisualIndex {
    const existing = this.load(projectId, mediaChecksum) ?? {
      projectId,
      mediaChecksum,
      updatedAt: Date.now(),
      segments: [],
    };
    const merged = [...existing.segments];
    for (const segment of segments) {
      const idx = merged.findIndex(
        (s) => s.startMs === segment.startMs && s.endMs === segment.endMs,
      );
      if (idx >= 0) merged[idx] = segment;
      else merged.push(segment);
    }
    merged.sort((a, b) => a.startMs - b.startMs);
    const next: VisualIndex = {
      projectId,
      mediaChecksum,
      updatedAt: Date.now(),
      segments: merged,
    };
    this.save(next);
    return next;
  }
}
