import type { EditOperation, EditPlan } from "@cutos/edit-dsl";
import {
  makeClipId,
  type Caption,
  type Clip,
  type Marker,
  type Timeline,
} from "./model.js";

/**
 * Pure, deterministic timeline transforms. Given the same timeline and
 * operation they always produce the same result, which is what makes an Edit
 * Plan replayable. They return new objects and never mutate their inputs or the
 * underlying source media.
 */

export class UnsupportedOperationError extends Error {
  constructor(public readonly opType: string) {
    super(`Operation "${opType}" is modeled in the Edit DSL but not yet applied by the timeline engine.`);
    this.name = "UnsupportedOperationError";
  }
}

interface Overlap {
  start: number;
  end: number;
}

function overlap(clip: Clip, startMs: number, endMs: number): Overlap | null {
  const start = Math.max(clip.sourceInMs, startMs);
  const end = Math.min(clip.sourceOutMs, endMs);
  return end > start ? { start, end } : null;
}

function clip(sourceInMs: number, sourceOutMs: number, speed: number): Clip {
  return { id: makeClipId(sourceInMs, sourceOutMs), sourceInMs, sourceOutMs, speed };
}

/** Ripple-remove the source range [startMs, endMs) from every clip. */
function removeRange(clips: Clip[], startMs: number, endMs: number): Clip[] {
  const next: Clip[] = [];
  for (const c of clips) {
    const ov = overlap(c, startMs, endMs);
    if (!ov) {
      next.push(c);
      continue;
    }
    if (ov.start > c.sourceInMs) next.push(clip(c.sourceInMs, ov.start, c.speed));
    if (ov.end < c.sourceOutMs) next.push(clip(ov.end, c.sourceOutMs, c.speed));
  }
  return next;
}

/** Set playback speed on the source range [startMs, endMs), splitting clips. */
function setSpeed(clips: Clip[], startMs: number, endMs: number, speed: number): Clip[] {
  const next: Clip[] = [];
  for (const c of clips) {
    const ov = overlap(c, startMs, endMs);
    if (!ov) {
      next.push(c);
      continue;
    }
    if (ov.start > c.sourceInMs) next.push(clip(c.sourceInMs, ov.start, c.speed));
    next.push(clip(ov.start, ov.end, speed));
    if (ov.end < c.sourceOutMs) next.push(clip(ov.end, c.sourceOutMs, c.speed));
  }
  return next;
}

/** Split the clip containing `atMs` into two adjacent clips. */
function splitAt(clips: Clip[], atMs: number): Clip[] {
  const next: Clip[] = [];
  for (const c of clips) {
    if (atMs > c.sourceInMs && atMs < c.sourceOutMs) {
      next.push(clip(c.sourceInMs, atMs, c.speed));
      next.push(clip(atMs, c.sourceOutMs, c.speed));
    } else {
      next.push(c);
    }
  }
  return next;
}

function addCaption(timeline: Timeline, op: Extract<EditOperation, { type: "caption" }>): Caption[] {
  const caption: Caption = {
    id: op.id ?? `cap_${op.startMs}_${op.endMs}`,
    startMs: op.startMs,
    endMs: op.endMs,
    text: op.text,
  };
  return [...(timeline.captions ?? []), caption].sort((a, b) => a.startMs - b.startMs);
}

function addMarker(timeline: Timeline, op: Extract<EditOperation, { type: "marker" }>): Marker[] {
  const marker: Marker = { id: op.id ?? `mk_${op.atMs}`, atMs: op.atMs, label: op.label };
  return [...(timeline.markers ?? []), marker].sort((a, b) => a.atMs - b.atMs);
}

export function applyOperation(timeline: Timeline, op: EditOperation): Timeline {
  switch (op.type) {
    case "removeRange":
    case "deleteRange":
      return withClips(timeline, removeRange(timeline.track.clips, op.startMs, op.endMs));
    case "trim": {
      const duration = timeline.source.durationMs;
      let clips = removeRange(timeline.track.clips, 0, op.startMs);
      clips = removeRange(clips, op.endMs, duration);
      return withClips(timeline, clips);
    }
    case "split":
      return withClips(timeline, splitAt(timeline.track.clips, op.atMs));
    case "setSpeed":
      return withClips(timeline, setSpeed(timeline.track.clips, op.startMs, op.endMs, op.speed));
    case "caption":
      return { ...timeline, captions: addCaption(timeline, op) };
    case "marker":
      return { ...timeline, markers: addMarker(timeline, op) };
    default:
      throw new UnsupportedOperationError(op.type);
  }
}

function withClips(timeline: Timeline, clips: Clip[]): Timeline {
  return { ...timeline, track: { ...timeline.track, clips } };
}

/** Fold a validated Edit Plan over a timeline, returning a new timeline. */
export function applyPlan(timeline: Timeline, plan: EditPlan): Timeline {
  return plan.operations.reduce(applyOperation, timeline);
}
