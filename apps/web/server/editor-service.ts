import { randomUUID } from "node:crypto";
import { isPlanStale } from "@cutos/edit-dsl";
import {
  TimelineHistory,
  applyOperation,
  applyPlan,
  timelineDurationMs,
  UnsupportedOperationError,
} from "@cutos/timeline";
import { estimateImpact } from "@cutos/agent";
import { compileTimelineToPreview, type PreviewManifest } from "@cutos/preview";
import { probeMetadata, synthesizeSample } from "@cutos/media";
import type { AnalysisSection } from "@cutos/media";
import { config, isAllowedMime } from "./config.js";
import { getRuntime } from "./runtime.js";
import { buildProjectDTO, buildProjectSummaries } from "./dto.js";
import { HttpError } from "./errors.js";
import { logger } from "./logger.js";

const DEFAULT_SECTIONS: AnalysisSection[] = ["metadata", "silences", "waveform", "transcript"];

async function importFromTemp(tempPath: string, name: string): Promise<string> {
  const { store, storage } = getRuntime();
  const meta = await probeMetadata(tempPath);
  if (!meta.hasVideo && !meta.hasAudio) {
    throw new HttpError(400, "MEDIA_UNSUPPORTED", "File has no video or audio stream.");
  }

  const projectId = randomUUID();
  const key = `sources/${projectId}/original.mp4`;
  const put = await storage.putFile(key, tempPath, { move: true });

  store.createProject({
    id: projectId,
    name,
    source: {
      id: projectId,
      uri: `storage://${key}`,
      durationMs: meta.durationMs,
      hasAudio: meta.hasAudio,
    },
    width: meta.width,
    height: meta.height,
  });

  store.addAsset({
    id: `original_${projectId}`,
    projectId,
    kind: "original",
    mimeType: "video/mp4",
    storageKey: key,
    checksum: put.checksum,
    sizeBytes: put.size,
    durationMs: meta.durationMs,
    width: meta.width,
    height: meta.height,
    codec: meta.videoCodec,
    createdAt: Date.now(),
  });

  logger.child({ projectId }).info("imported project", { name, durationMs: meta.durationMs });
  return projectId;
}

export async function importSample(): Promise<string> {
  const { storage } = getRuntime();
  const temp = storage.tempFile("mp4");
  await synthesizeSample(temp);
  return importFromTemp(temp, "Demo clip (12s)");
}

export async function importUpload(file: File): Promise<string> {
  if (file.size > config.maxUploadBytes) {
    throw new HttpError(413, "UPLOAD_TOO_LARGE", `File exceeds the ${Math.round(config.maxUploadBytes / 1024 / 1024)}MB limit.`);
  }
  if (file.type && !isAllowedMime(file.type)) {
    throw new HttpError(415, "MEDIA_UNSUPPORTED", `Unsupported media type: ${file.type}`);
  }
  const { storage } = getRuntime();
  await storage.ensureTempDir();
  const temp = storage.tempFile("upload");
  const bytes = Buffer.from(await file.arrayBuffer());
  const { writeFile } = await import("node:fs/promises");
  await writeFile(temp, bytes);
  return importFromTemp(temp, file.name || "Imported video");
}

export function enqueueAnalyze(
  projectId: string,
  opts?: { thresholdDb?: number; minSilenceMs?: number },
): string {
  const { store, jobStore } = getRuntime();
  store.requireProject(projectId);
  const job = jobStore.enqueue({
    kind: "analyze",
    projectId,
    payload: { projectId, sections: DEFAULT_SECTIONS, silenceOptions: opts },
    maxAttempts: 2,
  });
  return job.id;
}

export function enqueueExport(projectId: string): string {
  const { store, jobStore } = getRuntime();
  const state = store.loadTimeline(projectId);
  if (!state || timelineDurationMs(state.current) <= 0) {
    throw new HttpError(409, "EMPTY_TIMELINE", "Timeline is empty; nothing to export.");
  }
  const job = jobStore.enqueue({ kind: "export", projectId, payload: { projectId }, maxAttempts: 2 });
  return job.id;
}

export async function plan(projectId: string, instruction: string) {
  const { store, agentRuntime } = getRuntime();
  store.requireProject(projectId);
  const run = await agentRuntime.planEdit({ projectId, instruction });
  return { runId: run.id, status: run.status, dto: buildProjectDTO(projectId) };
}

function loadHistory(projectId: string): TimelineHistory {
  const { store } = getRuntime();
  const state = store.loadTimeline(projectId);
  if (!state) throw new HttpError(404, "TIMELINE_NOT_FOUND", "Timeline not found.");
  return TimelineHistory.restore(state);
}

export function rejectOperation(projectId: string, opIndex: number) {
  const { store } = getRuntime();
  const plan = store.loadPendingPlan(projectId);
  if (!plan) throw new HttpError(409, "NO_PENDING_PLAN", "No pending plan to edit.");
  const operations = plan.operations.filter((_, i) => i !== opIndex);
  if (operations.length === 0) {
    store.savePendingPlan(projectId, null);
  } else {
    store.savePendingPlan(projectId, { ...plan, operations });
  }
  return buildProjectDTO(projectId);
}

export function previewOperation(projectId: string, opIndex: number) {
  const { store } = getRuntime();
  const project = store.requireProject(projectId);
  const plan = store.loadPendingPlan(projectId);
  const op = plan?.operations[opIndex];
  if (!plan || !op) throw new HttpError(404, "OPERATION_NOT_FOUND", "Operation not found.");
  const single = { ...plan, operations: [op] };
  const impact = estimateImpact(single, project.source.durationMs);
  return {
    opIndex,
    removedMs: impact.removedMs,
    estimatedDurationMs: impact.estimatedDurationMs,
    riskLevel: impact.riskLevel,
  };
}

/** Ephemeral preview manifest for one pending operation (never persisted). */
export function previewOperationManifest(projectId: string, opIndex: number): PreviewManifest {
  const { store } = getRuntime();
  const plan = store.loadPendingPlan(projectId);
  const op = plan?.operations[opIndex];
  if (!plan || !op) throw new HttpError(404, "OPERATION_NOT_FOUND", "Operation not found.");
  const history = loadHistory(projectId);
  try {
    const ephemeral = applyOperation(history.current, op);
    return compileTimelineToPreview(ephemeral, { timelineRevision: history.revision });
  } catch (error) {
    if (error instanceof UnsupportedOperationError) {
      throw new HttpError(422, "PREVIEW_UNSUPPORTED", error.message);
    }
    throw error;
  }
}

/** Ephemeral preview manifest for the whole pending plan (never persisted). */
export function previewPlanManifest(projectId: string): PreviewManifest {
  const { store } = getRuntime();
  const plan = store.loadPendingPlan(projectId);
  if (!plan) throw new HttpError(409, "NO_PENDING_PLAN", "No pending plan to preview.");
  const history = loadHistory(projectId);
  try {
    const ephemeral = applyPlan(history.current, plan);
    return compileTimelineToPreview(ephemeral, { timelineRevision: history.revision });
  } catch (error) {
    if (error instanceof UnsupportedOperationError) {
      throw new HttpError(422, "PREVIEW_UNSUPPORTED", error.message);
    }
    throw error;
  }
}

export function discardPending(projectId: string) {
  const { store } = getRuntime();
  store.savePendingPlan(projectId, null);
  return buildProjectDTO(projectId);
}

export function applyPending(projectId: string) {
  const { store, agentRunStore, agentRuntime } = getRuntime();
  const project = store.requireProject(projectId);
  const plan = store.loadPendingPlan(projectId);
  if (!plan) throw new HttpError(409, "NO_PENDING_PLAN", "No pending plan to apply.");

  const history = loadHistory(projectId);
  if (isPlanStale(plan, history.revision)) {
    throw new HttpError(409, "STALE_EDIT_PLAN", "The plan is stale (the timeline changed).");
  }

  const impact = estimateImpact(plan, project.source.durationMs);
  if (impact.unsupportedOperations.length > 0) {
    throw new HttpError(
      422,
      "UNSUPPORTED_OPERATION",
      `Plan contains operations not yet supported: ${impact.unsupportedOperations.join(", ")}`,
    );
  }

  const before = timelineDurationMs(history.current);
  history.apply(plan);
  const after = timelineDurationMs(history.current);
  store.saveTimeline(projectId, history.serialize());
  store.appendOperation({
    projectId,
    at: Date.now(),
    revision: history.revision,
    kind: "apply",
    planId: plan.id,
    summary: plan.summary,
    operationCount: plan.operations.length,
  });
  store.savePendingPlan(projectId, null);

  const run = agentRunStore
    .listByProject(projectId)
    .find((r) => r.planId === plan.id && r.status === "awaiting_approval");
  if (run) {
    agentRuntime.completeRun(run.id, { beforeDurationMs: before, afterDurationMs: after, impact });
  }
  logger.child({ projectId }).info("applied plan", { planId: plan.id, before, after });
  return buildProjectDTO(projectId);
}

function historyMutation(projectId: string, kind: "undo" | "redo") {
  const { store } = getRuntime();
  const history = loadHistory(projectId);
  if (kind === "undo") history.undo();
  else history.redo();
  store.saveTimeline(projectId, history.serialize());
  store.appendOperation({
    projectId,
    at: Date.now(),
    revision: history.revision,
    kind,
    planId: null,
    summary: null,
    operationCount: 0,
  });
  return buildProjectDTO(projectId);
}

export const undo = (projectId: string) => historyMutation(projectId, "undo");
export const redo = (projectId: string) => historyMutation(projectId, "redo");

export async function deleteProject(projectId: string): Promise<void> {
  const { store, storage } = getRuntime();
  const assets = store.media.listAssets(projectId);
  for (const asset of assets) {
    await storage.delete(asset.storageKey).catch(() => undefined);
  }
  store.deleteProject(projectId);
}

export function getProject(projectId: string) {
  return buildProjectDTO(projectId);
}

export function listProjects() {
  return buildProjectSummaries();
}

export function getJob(jobId: string) {
  const { jobStore } = getRuntime();
  const job = jobStore.get(jobId);
  if (!job) throw new HttpError(404, "JOB_NOT_FOUND", "Job not found.");
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    error: job.error,
  };
}

export function cancelJob(jobId: string) {
  const { jobStore } = getRuntime();
  jobStore.cancel(jobId);
  return getJob(jobId);
}

export function retryJob(jobId: string) {
  const { jobStore } = getRuntime();
  const job = jobStore.get(jobId);
  if (!job) throw new HttpError(404, "JOB_NOT_FOUND", "Job not found.");
  if (job.status === "queued" || job.status === "running") return getJob(jobId);
  jobStore.retry(jobId);
  return getJob(jobId);
}

/**
 * Agent-run inspection for the AIOS control plane. AIOS holds the DAG; CUTOS
 * holds the editing run it produced, and these three calls are how AIOS
 * reconciles the two after a restart on either side.
 */
export function getAgentRun(runId: string) {
  const { agentRunStore } = getRuntime();
  const run = agentRunStore.get(runId);
  if (!run) throw new HttpError(404, "OPERATION_NOT_FOUND", "Agent run not found.");
  return {
    id: run.id,
    projectId: run.projectId,
    status: run.status,
    input: run.input,
    planId: run.planId,
    summary: run.summary,
    error: run.error,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    steps: run.steps.map((step) => ({
      at: step.at,
      kind: step.kind,
      title: step.title,
      detail: step.detail,
      data: step.data,
    })),
  };
}

/**
 * Cancel an editing run. A run that has already been applied is terminal --
 * cancelling it would imply undoing a committed timeline mutation, which must
 * go through undo, not through run control.
 */
export function cancelAgentRun(runId: string) {
  const { agentRunStore, store } = getRuntime();
  const run = agentRunStore.get(runId);
  if (!run) throw new HttpError(404, "OPERATION_NOT_FOUND", "Agent run not found.");
  if (run.status === "applied" || run.status === "completed") {
    throw new HttpError(409, "VALIDATION_FAILED", "Run already completed; use undo instead.");
  }
  if (run.status !== "cancelled") {
    run.status = "cancelled";
    run.updatedAt = Date.now();
    run.steps.push({
      at: run.updatedAt,
      kind: "error",
      title: "Run cancelled",
      detail: "cancelled by the control plane",
    });
    agentRunStore.save(run);
    // A cancelled run must not leave a stageable plan behind.
    const pending = store.loadPendingPlan(run.projectId);
    if (pending && pending.id === run.planId) store.savePendingPlan(run.projectId, null);
  }
  return getAgentRun(runId);
}

/**
 * Resume a run that is waiting for approval. This does not re-plan: it reports
 * whether the staged plan is still applicable against the current revision, so
 * AIOS can decide between apply and replan.
 */
export function resumeAgentRun(runId: string) {
  const { agentRunStore, store } = getRuntime();
  const run = agentRunStore.get(runId);
  if (!run) throw new HttpError(404, "OPERATION_NOT_FOUND", "Agent run not found.");
  const state = store.loadTimeline(run.projectId);
  const revision = state?.revision ?? store.requireProject(run.projectId).timelineRevision;
  const pending = store.loadPendingPlan(run.projectId);
  const planStillStaged = Boolean(pending && pending.id === run.planId);
  const stale = planStillStaged && pending ? isPlanStale(pending, revision) : false;
  return {
    ...getAgentRun(runId),
    resumable: run.status === "awaiting_approval" && planStillStaged && !stale,
    planStillStaged,
    stale,
    timelineRevision: revision,
  };
}
