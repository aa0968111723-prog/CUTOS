import type { EditPlan } from "@cutos/edit-dsl";
import { applyPlan } from "./transforms.js";
import type { Timeline } from "./model.js";

export interface HistoryEntry {
  plan: EditPlan;
  /** Timeline snapshot AFTER the plan was applied. */
  timeline: Timeline;
}

/**
 * Non-destructive edit history. Because timelines are immutable snapshots and
 * plans are retained, every edit is fully reversible (undo/redo) and auditable.
 * The applied plans are the replayable record of how the timeline was reached.
 */
export class TimelineHistory {
  private readonly initial: Timeline;
  private present: Timeline;
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];

  constructor(initial: Timeline) {
    this.initial = initial;
    this.present = initial;
  }

  get current(): Timeline {
    return this.present;
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
    return next;
  }

  undo(): Timeline {
    const entry = this.past.pop();
    if (!entry) {
      return this.present;
    }
    this.future.unshift(entry);
    const previous = this.past.at(-1);
    this.present = previous ? previous.timeline : this.initial;
    return this.present;
  }

  redo(): Timeline {
    const entry = this.future.shift();
    if (!entry) {
      return this.present;
    }
    this.past.push(entry);
    this.present = entry.timeline;
    return this.present;
  }
}
