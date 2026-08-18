import { z } from "zod";
import { EditPlanSchema } from "@cutos/edit-dsl";
import { SourceMediaSchema, TimelineSchema } from "@cutos/timeline";
import { MediaAssetSchema, VideoAnalysisSchema } from "@cutos/media";

/** Bump when the persisted shape changes; migrations key off this. */
export const CURRENT_SCHEMA_VERSION = 1 as const;

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
