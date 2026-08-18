import {
  isImplementedOperation,
  isPlanStale,
  type EditOperation,
  type EditPlan,
} from "@cutos/edit-dsl";
import { clipOutputDurationMs, timelineDurationMs } from "@cutos/timeline";
import { compileTimelineToPreview } from "@cutos/preview";
import { DefaultApprovalPolicy, createPlanner, estimateImpact, type AgentRun } from "@cutos/agent";
import type {
  AgentRunDTO,
  ImpactDTO,
  OperationDTO,
  PendingPlanDTO,
  ProjectDTO,
  ProjectSummaryDTO,
} from "../app/lib/types.js";
import { getRuntime } from "./runtime.js";

function estimatedRemovedMs(op: EditOperation, sourceDurationMs: number): number {
  switch (op.type) {
    case "removeRange":
    case "deleteRange":
      return Math.max(0, op.endMs - op.startMs);
    case "trim":
      return Math.max(0, sourceDurationMs - (op.endMs - op.startMs));
    case "setSpeed": {
      const span = Math.max(0, op.endMs - op.startMs);
      const shorter = span - Math.round(span / op.speed);
      return shorter > 0 ? shorter : 0;
    }
    default:
      return 0;
  }
}

function toOperationDTO(op: EditOperation, index: number, sourceDurationMs: number): OperationDTO {
  const raw = op as Record<string, unknown>;
  const num = (k: string) => (typeof raw[k] === "number" ? (raw[k] as number) : undefined);
  return {
    index,
    type: op.type,
    startMs: num("startMs"),
    endMs: num("endMs"),
    atMs: num("atMs"),
    speed: op.type === "setSpeed" ? op.speed : undefined,
    reason: op.reason,
    confidence: op.confidence,
    estimatedRemovedMs: estimatedRemovedMs(op, sourceDurationMs),
    supported: isImplementedOperation(op.type),
  };
}

function toImpactDTO(plan: EditPlan, sourceDurationMs: number): ImpactDTO {
  const impact = estimateImpact(plan, sourceDurationMs);
  return {
    sourceDurationMs: impact.sourceDurationMs,
    estimatedDurationMs: impact.estimatedDurationMs,
    removedMs: impact.removedMs,
    addedMs: impact.addedMs,
    operationCount: impact.operationCount,
    riskLevel: impact.riskLevel,
    unsupportedOperations: impact.unsupportedOperations,
  };
}

function toPendingPlanDTO(plan: EditPlan, sourceDurationMs: number, currentRevision: number): PendingPlanDTO {
  const impact = estimateImpact(plan, sourceDurationMs);
  const decision = new DefaultApprovalPolicy().evaluate(impact);
  return {
    id: plan.id,
    instruction: plan.instruction,
    summary: plan.summary,
    provider: plan.provider,
    targetRevision: plan.targetRevision,
    stale: isPlanStale(plan, currentRevision),
    operations: plan.operations.map((op, i) => toOperationDTO(op, i, sourceDurationMs)),
    impact: toImpactDTO(plan, sourceDurationMs),
    requiresApproval: decision.requiresApproval,
    approvalReason: decision.reason,
  };
}

function toAgentRunDTO(run: AgentRun): AgentRunDTO {
  return {
    id: run.id,
    input: run.input,
    status: run.status,
    createdAt: run.createdAt,
    summary: run.summary,
    error: run.error,
    steps: run.steps.map((s) => ({ at: s.at, kind: s.kind, title: s.title, detail: s.detail })),
  };
}

export function buildProjectDTO(id: string): ProjectDTO {
  const { store, agentRunStore } = getRuntime();
  const project = store.requireProject(id);
  const state = store.loadTimeline(id);
  const timeline = state?.current ?? { track: { clips: [] }, captions: [], markers: [] };
  const analysis = store.loadAnalysis(id);
  const pending = store.loadPendingPlan(id);
  const currentRevision = state?.revision ?? project.timelineRevision;
  const durationMs = state ? timelineDurationMs(state.current) : project.source.durationMs;
  const exportAsset = store.getAssetByKind(id, "export");
  const preview = state
    ? compileTimelineToPreview(state.current, { timelineRevision: currentRevision })
    : {
        timelineRevision: currentRevision,
        durationMs,
        hasAudio: project.source.hasAudio,
        segments: [],
        captions: [],
        markers: [],
      };

  return {
    id: project.id,
    name: project.name,
    version: project.version,
    updatedAt: project.updatedAt,
    provider: createPlanner().name,
    timelineRevision: currentRevision,
    source: {
      durationMs: project.source.durationMs,
      hasAudio: project.source.hasAudio,
      width: project.width,
      height: project.height,
    },
    analysis: analysis
      ? {
          silences: analysis.silences ?? [],
          hasWaveform: Boolean(analysis.waveform),
          sentenceCount: analysis.transcript?.sentences.length ?? 0,
        }
      : undefined,
    timeline: {
      durationMs,
      clips: timeline.track.clips.map((clip) => ({
        id: clip.id,
        sourceInMs: clip.sourceInMs,
        sourceOutMs: clip.sourceOutMs,
        speed: clip.speed,
        outputDurationMs: clipOutputDurationMs(clip),
      })),
      captions: timeline.captions ?? [],
      markers: timeline.markers ?? [],
    },
    operationLog: store.operations(id).slice(-20).map((entry) => ({
      id: entry.id,
      at: entry.at,
      revision: entry.revision,
      kind: entry.kind,
      summary: entry.summary,
      operationCount: entry.operationCount,
    })),
    canUndo: (state?.past.length ?? 0) > 0,
    canRedo: (state?.future.length ?? 0) > 0,
    pendingPlan: pending ? toPendingPlanDTO(pending, project.source.durationMs, currentRevision) : undefined,
    agentRuns: agentRunStore.listByProject(id).slice(0, 5).map(toAgentRunDTO),
    hasExport: Boolean(exportAsset),
    exportDurationMs: exportAsset?.durationMs ?? undefined,
    preview,
  };
}

export function buildProjectSummaries(): ProjectSummaryDTO[] {
  const { store } = getRuntime();
  return store.listProjects().map((p) => ({
    id: p.id,
    name: p.name,
    updatedAt: p.updatedAt,
    timelineRevision: p.timelineRevision,
    durationMs: p.source.durationMs,
  }));
}
