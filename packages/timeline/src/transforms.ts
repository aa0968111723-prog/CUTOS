import type { EditOperation, EditPlan } from "@cutos/edit-dsl";
import { makeClipId, type Clip, type Timeline } from "./model.js";

/**
 * Pure, deterministic timeline transforms. Given the same timeline and
 * operation, they always produce the same result, which is what makes an Edit
 * Plan replayable. They return new objects and never mutate their inputs or the
 * underlying source media.
 */

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
    if (ov.start > c.sourceInMs) {
      next.push(clip(c.sourceInMs, ov.start, c.speed));
    }
    if (ov.end < c.sourceOutMs) {
      next.push(clip(ov.end, c.sourceOutMs, c.speed));
    }
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
    if (ov.start > c.sourceInMs) {
      next.push(clip(c.sourceInMs, ov.start, c.speed));
    }
    next.push(clip(ov.start, ov.end, speed));
    if (ov.end < c.sourceOutMs) {
      next.push(clip(ov.end, c.sourceOutMs, c.speed));
    }
  }
  return next;
}

export function applyOperation(timeline: Timeline, op: EditOperation): Timeline {
  let clips = timeline.track.clips;
  switch (op.type) {
    case "removeRange":
      clips = removeRange(clips, op.startMs, op.endMs);
      break;
    case "setSpeed":
      clips = setSpeed(clips, op.startMs, op.endMs, op.speed);
      break;
  }
  return {
    ...timeline,
    track: { ...timeline.track, clips },
  };
}

/** Fold a validated Edit Plan over a timeline, returning a new timeline. */
export function applyPlan(timeline: Timeline, plan: EditPlan): Timeline {
  return plan.operations.reduce(applyOperation, timeline);
}
