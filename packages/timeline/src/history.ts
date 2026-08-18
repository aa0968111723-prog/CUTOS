import type { EditPlan } from "@cutos/edit-dsl";
import { applyPlan } from "./transforms.js";
import { createTimeline, type Timeline } from "./model.js";

export interface HistoryEntry {
  plan: EditPlan;
  /** Timeline snapshot AFTER the plan was applied. */
  timeline: Timeline;
}

/** Serializable snapshot of a history, so undo/redo survives a restart. */
export interface TimelineSnapshot {
  revision: number;
  current: Timeline;
  past: HistoryEntry[];
  future: HistoryEntry[];
}

/**
 * Non-destructive edit history. Because timelines are immutable snapshots and
 * plans are retained, every edit is fully reversible (undo/redo) and auditable.
 * A monotonically increasing `revision` identifies the current state so Edit
 * Plans can target a revision and stale plans can be detected. The whole
 * history can be serialized and restored, making undo/redo durable.
 */
export class TimelineHistory {
  private readonly initial: Timeline;
  private present: Timeline;
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  private rev: number;

  constructor(initial: Timeline, options: { revision?: number } = {}) {
    this.initial = initial;
    this.present = initial;
    this.rev = options.revision ?? 0;
  }

  get current(): Timeline {
    return this.present;
  }

  get revision(): number {
    return this.rev;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Applied plans, oldest first. */
  get appliedPlans(): EditPlan[] {
    return this.past.map((entry) => entry.plan);
  }

  apply(plan: EditPlan): Timeline {
    const next = applyPlan(this.present, plan);
    this.past.push({ plan, timeline: next });
    this.future = [];
    this.present = next;
    this.rev += 1;
    return next;
  }

  undo(): Timeline {
    const entry = this.past.pop();
    if (!entry) return this.present;
    this.future.unshift(entry);
    const previous = this.past.at(-1);
    this.present = previous ? previous.timeline : this.initial;
    this.rev += 1;
    return this.present;
  }

  redo(): Timeline {
    const entry = this.future.shift();
    if (!entry) return this.present;
    this.past.push(entry);
    this.present = entry.timeline;
    this.rev += 1;
    return this.present;
  }

  /** Serialize the full history (current + undo/redo stacks + revision). */
  serialize(): TimelineSnapshot {
    return structuredClone({
      revision: this.rev,
      current: this.present,
      past: this.past,
      future: this.future,
    });
  }

  /**
   * Rebuild a history from a serialized snapshot (durable undo/redo). The
   * pre-edit baseline is reconstructed deterministically from the source, since
   * histories always start at `createTimeline(source)`.
   */
  static restore(snapshot: TimelineSnapshot): TimelineHistory {
    const baseline = createTimeline(snapshot.current.source);
    const history = new TimelineHistory(baseline, { revision: snapshot.revision });
    history.present = snapshot.current;
    history.past = structuredClone(snapshot.past);
    history.future = structuredClone(snapshot.future);
    return history;
  }
}
