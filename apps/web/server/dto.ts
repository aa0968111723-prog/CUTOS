import type { EditPlan } from "@cutos/edit-dsl";
import { clipOutputDurationMs, timelineDurationMs } from "@cutos/timeline";
import { createPlanner } from "@cutos/agent";
import type { OperationDTO, PendingPlanDTO, ProjectDTO } from "../app/lib/types.js";
import type { ProjectRecord } from "./store.js";

function toOperationDTO(op: EditPlan["operations"][number]): OperationDTO {
  return {
    type: op.type,
    startMs: op.startMs,
    endMs: op.endMs,
    speed: op.type === "setSpeed" ? op.speed : undefined,
    reason: op.reason,
  };
}

function toPendingPlanDTO(plan: EditPlan): PendingPlanDTO {
  return {
    id: plan.id,
    instruction: plan.instruction,
    summary: plan.summary,
    provider: plan.provider,
    operations: plan.operations.map(toOperationDTO),
  };
}

export function toProjectDTO(record: ProjectRecord): ProjectDTO {
  const timeline = record.history.current;
  return {
    id: record.id,
    name: record.name,
    provider: createPlanner().name,
    source: {
      durationMs: record.source.durationMs,
      hasAudio: record.source.hasAudio,
      width: record.width,
      height: record.height,
    },
    analysis: record.analysis
      ? {
          thresholdDb: record.analysis.thresholdDb,
          minSilenceMs: record.analysis.minSilenceMs,
          silences: record.analysis.silences,
        }
      : undefined,
    timeline: {
      durationMs: timelineDurationMs(timeline),
      clips: timeline.track.clips.map((clip) => ({
        id: clip.id,
        sourceInMs: clip.sourceInMs,
        sourceOutMs: clip.sourceOutMs,
        speed: clip.speed,
        outputDurationMs: clipOutputDurationMs(clip),
      })),
    },
    appliedPlans: record.history.appliedPlans.map((plan) => ({
      id: plan.id,
      instruction: plan.instruction,
      summary: plan.summary,
      provider: plan.provider,
      operationCount: plan.operations.length,
    })),
    canUndo: record.history.canUndo,
    canRedo: record.history.canRedo,
    pendingPlan: record.pendingPlan ? toPendingPlanDTO(record.pendingPlan) : undefined,
    output: record.output ? { durationMs: record.output.durationMs } : undefined,
  };
}
