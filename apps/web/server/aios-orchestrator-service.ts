import { randomUUID } from "node:crypto";
import {
  AiosOrchestratorError,
  createAiosOrchestrator,
  readOrchestratorConfig,
  type AiosOrchestrator,
  type AiosOrchestratorHealth,
} from "@cutos/agent";
import {
  CUTOS_PROTOCOL_VERSION,
  aiosRunRequestSchema,
  argsFingerprint,
  cutosIdempotencyKey,
  type AiosRunRequest,
  type AiosRunState,
  type QualityProfile,
} from "@cutos/protocol";
import type { AiosRunRecord } from "@cutos/project-store";
import { getRuntime } from "./runtime.js";
import { HttpError } from "./errors.js";
import { recordActivity } from "./aios-activity.js";
import { buildProjectSemanticContext } from "./semantic-service.js";

/**
 * The CUTOS-side orchestration service.
 *
 * `AiosOrchestrator` is the transport; this module is the durable half. Every
 * submitted run is written to the project store BEFORE the HTTP call, keyed by
 * a derived idempotency key, so a CUTOS restart mid-submit cannot produce two
 * AIOS runs for one user goal — on restart the handle is found and reconciled
 * against AIOS rather than resubmitted.
 */

let override: AiosOrchestrator | null | undefined;

/** Test seam: inject an orchestrator (or null to force "not configured"). */
export function setAiosOrchestrator(value: AiosOrchestrator | null | undefined): void {
  override = value;
}

function orchestrator(): AiosOrchestrator {
  const resolved = override === undefined ? createAiosOrchestrator() : override;
  if (!resolved) {
    throw new HttpError(503, "VALIDATION_FAILED", "AIOS orchestration is not configured.");
  }
  return resolved;
}

export function isOrchestratorConfigured(): boolean {
  if (override !== undefined) return override !== null;
  return readOrchestratorConfig().configured;
}

export async function orchestratorHealth(): Promise<AiosOrchestratorHealth> {
  if (!isOrchestratorConfigured()) {
    return { reachable: false, compatible: false, messageKey: "aios.status.notConfigured" };
  }
  return orchestrator().health();
}

export interface SubmitRunInput {
  projectId: string;
  goal: string;
  capability: string;
  query?: string;
  qualityProfile?: QualityProfile;
  deadlineMs?: number;
  /** Attach a bounded semantic context built from the project's transcript. */
  withContext?: boolean;
  targetDurationMs?: number;
}

function toRecord(input: {
  id: string;
  projectId: string;
  capability: string;
  goal: string;
  qualityProfile: string;
  requestId: string;
  idempotencyKey: string;
  now: number;
}): AiosRunRecord {
  return {
    id: input.id,
    projectId: input.projectId,
    aiosRunId: null,
    status: "queued",
    capability: input.capability,
    goal: input.goal,
    qualityProfile: input.qualityProfile,
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    errorCode: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/**
 * Submit a goal to AIOS.
 *
 * CUTOS does retrieval first: when `withContext` is set the request carries a
 * bounded {@link CutosSemanticContext} rather than a transcript, so a 45-minute
 * interview never crosses the boundary wholesale.
 */
export async function submitAiosRun(
  input: SubmitRunInput,
  options: { now?: () => number } = {},
): Promise<{ handleId: string; aiosRunId: string; status: AiosRunState["status"]; state: AiosRunState }> {
  const now = options.now ?? (() => Date.now());
  const { store } = getRuntime();
  store.requireProject(input.projectId);

  const config = readOrchestratorConfig();
  const qualityProfile = input.qualityProfile ?? config.qualityProfile;
  const handleId = randomUUID();
  const requestId = randomUUID();

  // Derived, not random: a resubmit of the same goal for the same project finds
  // the existing handle instead of starting a duplicate AIOS run.
  const idempotencyKey = cutosIdempotencyKey({
    aiosRunId: "cutos-origin",
    aiosStepId: input.capability,
    capability: input.capability,
    cutosProjectId: input.projectId,
    argsFingerprint: argsFingerprint({ goal: input.goal, qualityProfile, query: input.query ?? "" }),
  });

  const existing = store.getAiosRunByIdempotencyKey(idempotencyKey);
  if (existing && existing.aiosRunId && !isTerminal(existing.status)) {
    const state = await orchestrator().getRun(existing.aiosRunId);
    persistState(existing, state, now());
    return { handleId: existing.id, aiosRunId: state.aiosRunId, status: state.status, state };
  }

  const record = existing ?? toRecord({
    id: handleId,
    projectId: input.projectId,
    capability: input.capability,
    goal: input.goal,
    qualityProfile,
    requestId,
    idempotencyKey,
    now: now(),
  });
  // Durable BEFORE the call: a crash here leaves a recoverable handle.
  store.saveAiosRun(record);

  recordActivity({
    projectId: input.projectId,
    kind: "run",
    status: "started",
    messageKey: "activity.aiosRun.submitting",
    metadata: { capability: input.capability, qualityProfile },
    now: now(),
  });

  const request: AiosRunRequest = aiosRunRequestSchema.parse({
    protocolVersion: CUTOS_PROTOCOL_VERSION,
    goal: input.goal,
    capability: input.capability,
    qualityProfile,
    ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
    ...(input.withContext
      ? {
        context: buildProjectSemanticContext({
          projectId: input.projectId,
          query: input.query ?? input.goal,
          requestId,
          capability: "build_semantic_context",
          ...(input.targetDurationMs === undefined ? {} : { targetDurationMs: input.targetDurationMs }),
        }),
      }
      : {}),
    correlation: {
      requestId,
      idempotencyKey,
      cutosProjectId: input.projectId,
    },
  });

  try {
    const handle = await orchestrator().submitRun(request);
    persistState(record, handle.state, now());
    recordActivity({
      projectId: input.projectId,
      kind: "run",
      status: "waiting_external",
      messageKey: "activity.aiosRun.submitted",
      aiosRunId: handle.aiosRunId,
      metadata: { capability: input.capability, status: handle.status },
      now: now(),
    });
    return {
      handleId: record.id,
      aiosRunId: handle.aiosRunId,
      status: handle.status,
      state: handle.state,
    };
  } catch (error) {
    const code = error instanceof AiosOrchestratorError ? error.code : "INTERNAL";
    store.saveAiosRun({ ...record, status: "failed", errorCode: code, updatedAt: now() });
    recordActivity({
      projectId: input.projectId,
      kind: "run",
      status: "failed",
      messageKey: "activity.aiosRun.failed",
      metadata: { capability: input.capability, code },
      now: now(),
    });
    throw error;
  }
}

function isTerminal(status: AiosRunRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function persistState(record: AiosRunRecord, state: AiosRunState, at: number): void {
  const { store } = getRuntime();
  store.saveAiosRun({
    ...record,
    aiosRunId: state.aiosRunId,
    status: state.status,
    state,
    errorCode: state.error?.code ?? null,
    updatedAt: at,
  });
}

function requireHandle(handleId: string): AiosRunRecord {
  const { store } = getRuntime();
  const record = store.getAiosRun(handleId);
  if (!record) throw new HttpError(404, "OPERATION_NOT_FOUND", "AIOS run handle not found.");
  return record;
}

export async function getAiosRun(handleId: string): Promise<AiosRunRecord> {
  const record = requireHandle(handleId);
  if (!record.aiosRunId || isTerminal(record.status)) return record;
  const state = await orchestrator().getRun(record.aiosRunId);
  persistState(record, state, Date.now());
  return requireHandle(handleId);
}

export async function cancelAiosRun(handleId: string): Promise<AiosRunRecord> {
  const record = requireHandle(handleId);
  if (!record.aiosRunId) {
    const { store } = getRuntime();
    store.saveAiosRun({ ...record, status: "cancelled", updatedAt: Date.now() });
    return requireHandle(handleId);
  }
  const state = await orchestrator().cancelRun(record.aiosRunId);
  persistState(record, state, Date.now());
  recordActivity({
    projectId: record.projectId,
    kind: "cancel",
    status: "cancelled",
    messageKey: "activity.aiosRun.cancelled",
    aiosRunId: record.aiosRunId,
  });
  return requireHandle(handleId);
}

/**
 * Resume after an interruption on either side. It re-reads the authoritative
 * AIOS state first — the whole point of restart recovery is that CUTOS asks
 * before it assumes.
 */
export async function resumeAiosRun(handleId: string): Promise<AiosRunRecord> {
  const record = requireHandle(handleId);
  if (!record.aiosRunId) {
    throw new HttpError(409, "VALIDATION_FAILED", "This run was never accepted by AIOS.");
  }
  const state = await orchestrator().resumeRun(record.aiosRunId);
  persistState(record, state, Date.now());
  recordActivity({
    projectId: record.projectId,
    kind: "run",
    status: state.status === "completed" ? "completed" : "progress",
    messageKey: "activity.aiosRun.resumed",
    aiosRunId: record.aiosRunId,
    metadata: { status: state.status },
  });
  return requireHandle(handleId);
}

/**
 * Reconcile every non-terminal handle for a project against AIOS. Called after
 * a CUTOS restart: CUTOS never assumes what happened while it was down.
 */
export async function reconcileAiosRuns(projectId: string): Promise<AiosRunRecord[]> {
  const { store } = getRuntime();
  const pending = store.listAiosRuns(projectId).filter((run) => !isTerminal(run.status));
  const out: AiosRunRecord[] = [];
  for (const record of pending) {
    if (!record.aiosRunId) {
      // Submitted-but-unacknowledged: AIOS never gave us an id, so nothing ran.
      store.saveAiosRun({ ...record, status: "failed", errorCode: "UNAVAILABLE", updatedAt: Date.now() });
      out.push(requireHandle(record.id));
      continue;
    }
    try {
      const state = await orchestrator().getRun(record.aiosRunId);
      persistState(record, state, Date.now());
      out.push(requireHandle(record.id));
    } catch (error) {
      // AIOS still down: leave the handle non-terminal so a later pass retries.
      const code = error instanceof AiosOrchestratorError ? error.code : "INTERNAL";
      store.saveAiosRun({ ...record, errorCode: code, updatedAt: Date.now() });
      out.push(requireHandle(record.id));
    }
  }
  return out;
}

export function listAiosRuns(projectId: string): AiosRunRecord[] {
  return getRuntime().store.listAiosRuns(projectId);
}
