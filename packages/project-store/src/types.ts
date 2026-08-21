import { z } from "zod";
import { EditPlanSchema } from "@cutos/edit-dsl";
import { SourceMediaSchema, TimelineSchema } from "@cutos/timeline";
import type { MediaAssetSchema, VideoAnalysisSchema } from "@cutos/media";

/** Bump when the persisted shape changes; migrations key off this. */
export const CURRENT_SCHEMA_VERSION = 2 as const;

export const ProjectRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  /** Optimistic-concurrency + change token; bumped on every project update. */
  version: z.number().int().nonnegative(),
  /** Increments on every timeline mutation; Edit Plans target a revision. */
  timelineRevision: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  source: SourceMediaSchema,
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
});
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;

export interface CreateProjectInput {
  id?: string;
  name: string;
  source: z.infer<typeof SourceMediaSchema>;
  width: number | null;
  height: number | null;
}

export interface ProjectPatch {
  name?: string;
  source?: z.infer<typeof SourceMediaSchema>;
  width?: number | null;
  height?: number | null;
  /** Set explicitly to override; otherwise store bumps it on timeline saves. */
  timelineRevision?: number;
}

/** Serializable undo/redo history + current timeline; survives restart. */
export const TimelineHistoryEntrySchema = z.object({
  plan: EditPlanSchema,
  timeline: TimelineSchema,
});
export type TimelineHistoryEntry = z.infer<typeof TimelineHistoryEntrySchema>;

export const PersistedTimelineStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  current: TimelineSchema,
  past: z.array(TimelineHistoryEntrySchema),
  future: z.array(TimelineHistoryEntrySchema),
});
export type PersistedTimelineState = z.infer<typeof PersistedTimelineStateSchema>;

export const OperationLogEntrySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  at: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  kind: z.enum(["apply", "undo", "redo"]),
  planId: z.string().nullable(),
  summary: z.string().nullable(),
  operationCount: z.number().int().nonnegative(),
});
export type OperationLogEntry = z.infer<typeof OperationLogEntrySchema>;

export type MediaAsset = z.infer<typeof MediaAssetSchema>;
export type VideoAnalysis = z.infer<typeof VideoAnalysisSchema>;

// ---------------------------------------------------------------------------
// Repository contracts. Backends implement these; the ProjectStore facade
// composes them. Swapping storage means implementing these four interfaces.
// ---------------------------------------------------------------------------

export interface ProjectRepository {
  create(input: CreateProjectInput): ProjectRecord;
  get(id: string): ProjectRecord | undefined;
  list(): ProjectRecord[];
  /**
   * Apply a patch. If `expectedVersion` is provided and does not match the
   * current version, throws {@link ConcurrencyError}. Bumps version+updatedAt.
   */
  update(id: string, patch: ProjectPatch, expectedVersion?: number): ProjectRecord;
  delete(id: string): void;
}

export interface TimelineRepository {
  save(projectId: string, state: PersistedTimelineState): void;
  load(projectId: string): PersistedTimelineState | undefined;
  savePendingPlan(projectId: string, plan: z.infer<typeof EditPlanSchema> | null): void;
  loadPendingPlan(projectId: string): z.infer<typeof EditPlanSchema> | null;
  appendOperation(entry: OperationLogEntry): void;
  operations(projectId: string): OperationLogEntry[];
  deleteForProject(projectId: string): void;
}

export interface MediaRepository {
  addAsset(asset: MediaAsset): void;
  getAsset(id: string): MediaAsset | undefined;
  getAssetByKind(projectId: string, kind: MediaAsset["kind"]): MediaAsset | undefined;
  listAssets(projectId: string): MediaAsset[];
  deleteAsset(id: string): void;
  deleteForProject(projectId: string): void;
}

export interface AnalysisRepository {
  save(projectId: string, analysis: VideoAnalysis): void;
  load(projectId: string): VideoAnalysis | undefined;
  deleteForProject(projectId: string): void;
}

/** An opaque, persisted agent-run record (the AgentRun shape lives in @cutos/agent). */
export interface RunRecord {
  id: string;
  projectId: string;
  createdAt: number;
  updatedAt: number;
  data: unknown;
}

export interface RunRepository {
  save(record: RunRecord): void;
  get(id: string): RunRecord | undefined;
  listByProject(projectId: string): RunRecord[];
  deleteForProject(projectId: string): void;
}

// ---------------------------------------------------------------------------
// AIOS bridge durability (schema v2)
//
// The cross-repo contract requires CUTOS to be the durable side of three
// things AIOS depends on to recover after either process restarts:
//   1. idempotency receipts   — a retried write must not mutate twice,
//   2. an activity event log  — the AIOS UI replays real progress, and
//   3. AIOS run handles       — CUTOS→AIOS orchestration survives a restart.
// ---------------------------------------------------------------------------

export const IdempotencyRecordSchema = z.object({
  /** projectId + capability + idempotencyKey, hashed into a single row key. */
  id: z.string().min(1),
  projectId: z.string().min(1),
  capability: z.string().min(1),
  idempotencyKey: z.string().min(1),
  /** The request that first claimed this key (for conflict diagnostics). */
  requestId: z.string().min(1),
  /** Hash of the semantic arguments; a mismatch is an IDEMPOTENCY_CONFLICT. */
  argsFingerprint: z.string().min(1),
  status: z.enum(["in_progress", "completed", "failed"]),
  /** Serialized capability result, present once completed. */
  result: z.unknown().optional(),
  /** Error code when the first attempt failed terminally. */
  errorCode: z.string().nullable(),
  /** Revision observed after the effect landed. */
  timelineRevision: z.number().int().nonnegative().nullable(),
  aiosRunId: z.string().nullable(),
  aiosStepId: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  /** Lease expiry for an in-flight claim; a crashed claim is reclaimable. */
  leaseExpiresAt: z.number().int().nonnegative().nullable(),
});
export type IdempotencyRecord = z.infer<typeof IdempotencyRecordSchema>;

export interface IdempotencyClaim {
  /**
   * `acquired`  — a brand-new claim; nothing has run, execute freely.
   * `reclaimed` — a PREVIOUS attempt held this key and its lease expired, i.e.
   *               the process died mid-effect. The caller now owns the key
   *               again, but it must NOT assume nothing happened: the earlier
   *               attempt may have already applied the edit or rendered the
   *               export before it died.
   * `in_progress` — another attempt holds a live lease.
   * `completed` / `failed` — a terminal outcome is on record; replay it.
   *
   * `acquired` and `reclaimed` were the same value until an audit found that
   * the caller re-executed on both, which is precisely what this table's own
   * docstring says must never happen ("a crashed CUTOS ... must not be re-run
   * blindly after restart"). Keeping them distinct is what lets the caller
   * reconcile instead of guessing.
   */
  state: "acquired" | "reclaimed" | "in_progress" | "completed" | "failed";
  record: IdempotencyRecord;
  /**
   * On `reclaimed`, the requestId of the attempt that died. `record.requestId`
   * has already been overwritten with the new attempt's id by the time the
   * caller sees it, so without this the recovery event could only report the
   * request that is recovering — never the one that needs investigating.
   */
  previousRequestId?: string;
}

export interface IdempotencyRepository {
  /**
   * Atomically claim the key. `acquired` means the caller owns the effect and
   * must execute it; `reclaimed` means it owns a key a dead attempt left behind
   * and must reconcile before acting; `in_progress` means another attempt holds
   * a live lease; `completed` returns the stored result so the caller replays
   * instead of mutating a second time.
   */
  claim(input: {
    projectId: string;
    capability: string;
    idempotencyKey: string;
    requestId: string;
    argsFingerprint: string;
    aiosRunId?: string | null;
    aiosStepId?: string | null;
    leaseMs: number;
    now: number;
  }): IdempotencyClaim;
  complete(id: string, result: unknown, timelineRevision: number | null, now: number): void;
  fail(id: string, errorCode: string, now: number): void;
  /** Release a claim without recording a terminal outcome (crash recovery). */
  release(id: string, now: number): void;
  get(projectId: string, capability: string, idempotencyKey: string): IdempotencyRecord | undefined;
  deleteForProject(projectId: string): void;
}

export const ActivityRecordSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  /** Monotonic per-project sequence so clients can resume a stream. */
  sequence: z.number().int().nonnegative(),
  at: z.number().int().nonnegative(),
  kind: z.string().min(1),
  status: z.string().min(1),
  messageKey: z.string().min(1),
  aiosRunId: z.string().nullable(),
  aiosStepId: z.string().nullable(),
  cutosAgentRunId: z.string().nullable(),
  cutosJobId: z.string().nullable(),
  /** Scalar-only metadata; the writer strips free text before it gets here. */
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
export type ActivityRecord = z.infer<typeof ActivityRecordSchema>;

export interface ActivityRepository {
  append(record: Omit<ActivityRecord, "sequence">): ActivityRecord;
  list(projectId: string, options?: { afterSequence?: number; limit?: number }): ActivityRecord[];
  deleteForProject(projectId: string): void;
}

export const AiosRunRecordSchema = z.object({
  /** CUTOS-side handle id. */
  id: z.string().min(1),
  projectId: z.string().min(1),
  /** Remote AIOS run id, once AIOS has accepted the submission. */
  aiosRunId: z.string().nullable(),
  status: z.enum([
    "queued", "running", "waiting_approval", "waiting_external",
    "completed", "failed", "cancelled",
  ]),
  capability: z.string().min(1),
  goal: z.string(),
  qualityProfile: z.string().min(1),
  requestId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  /** Last validated AiosRunState payload. */
  state: z.unknown().optional(),
  errorCode: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type AiosRunRecord = z.infer<typeof AiosRunRecordSchema>;

export interface AiosRunRepository {
  save(record: AiosRunRecord): void;
  get(id: string): AiosRunRecord | undefined;
  getByIdempotencyKey(key: string): AiosRunRecord | undefined;
  listByProject(projectId: string): AiosRunRecord[];
  deleteForProject(projectId: string): void;
}

export class ProjectNotFoundError extends Error {
  constructor(id: string) {
    super(`Project ${id} not found`);
    this.name = "ProjectNotFoundError";
  }
}

export class ConcurrencyError extends Error {
  constructor(id: string, expected: number, actual: number) {
    super(`Project ${id} version conflict: expected ${expected}, found ${actual}`);
    this.name = "ConcurrencyError";
  }
}
