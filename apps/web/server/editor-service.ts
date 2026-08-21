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

export interface AdoptUploadInput {
  projectId: string;
  assetId: string;
  name: string;
  /** Key the streamed bytes were sealed under. */
  storageKey: string;
  sizeBytes: number;
  checksum: string;
  mimeType: string;
}

/**
 * Register already-stored bytes as a project's original media.
 *
 * Nothing here reads the file: duration and dimensions are unknown until the
 * probe job runs, so the project starts at `mediaStatus: "uploaded"` with a
 * zero-length source. That is what lets the finalize request answer in
 * milliseconds instead of waiting on ffprobe — and what lets the home screen
 * show the project as processing rather than blocking on it.
 */
export function adoptUploadedAsset(input: AdoptUploadInput): void {
  const { store } = getRuntime();
  // No copy and no move: the resumable upload was staged against this exact
  // key and sealed into place. Rewriting a 500 MB file here would reintroduce
  // the stall this whole path exists to remove.
  const key = input.storageKey;

  store.createProject({
    id: input.projectId,
    name: input.name,
    source: {
      id: input.projectId,
      uri: `storage://${key}`,
      durationMs: 0,
      hasAudio: false,
    },
    width: null,
    height: null,
    mediaStatus: "uploaded",
  });

  store.addAsset({
    id: input.assetId,
    projectId: input.projectId,
    kind: "original",
    mimeType: input.mimeType,
    storageKey: key,
    checksum: input.checksum,
    sizeBytes: input.sizeBytes,
    durationMs: null,
    width: null,
    height: null,
    codec: null,
    createdAt: Date.now(),
  });

  logger.child({ projectId: input.projectId }).info("adopted uploaded media", {
    name: input.name,
    sizeBytes: input.sizeBytes,
  });
}

/**
 * Queue the media probe. Separate from the upload request by design: reading
 * metadata is media work, and media work belongs in a durable job that can
 * retry, report progress, and be re-run without another upload.
 */
export function enqueueProbe(projectId: string): string {
  const { store, jobStore } = getRuntime();
  const project = store.requireProject(projectId);
  if (project.mediaStatus !== "probing") {
    store.updateProject(projectId, { mediaStatus: "probing", mediaError: null });
  }
  const job = jobStore.enqueue({
    kind: "probe",
    projectId,
    payload: { projectId },
    maxAttempts: 2,
  });
  return job.id;
}

/**
 * Re-run the probe for a project whose media is stored but unreadable.
 *
 * The uploaded asset is never discarded on a probe failure, so recovering from
 * one costs a button press, not another upload over mobile data.
 */
export function retryProbe(projectId: string): { jobId: string } {
  const { store } = getRuntime();
  store.requireProject(projectId);
  const asset = store.getAssetByKind(projectId, "original");
  if (!asset) throw new HttpError(404, "MEDIA_MISSING", "No original media for this project.");
  return { jobId: enqueueProbe(projectId) };
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
