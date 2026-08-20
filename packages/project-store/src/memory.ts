import { randomUUID } from "node:crypto";
import type { EditPlan } from "@cutos/edit-dsl";
import { ProjectStore, type Repositories } from "./facade.js";
import {
  CURRENT_SCHEMA_VERSION,
  ConcurrencyError,
  ProjectNotFoundError,
  type AnalysisRepository,
  type CreateProjectInput,
  type MediaAsset,
  type MediaRepository,
  type OperationLogEntry,
  type PersistedTimelineState,
  type ProjectPatch,
  type ProjectRecord,
  type ProjectRepository,
  type ActivityRecord,
  type ActivityRepository,
  type AiosRunRecord,
  type AiosRunRepository,
  type IdempotencyClaim,
  type IdempotencyRecord,
  type IdempotencyRepository,
  type RunRecord,
  type RunRepository,
  type TimelineRepository,
  type VideoAnalysis,
} from "./types.js";
import { idempotencyRowId } from "./ids.js";

const clone = <T>(v: T): T => structuredClone(v);

class MemoryProjectRepository implements ProjectRepository {
  private rows = new Map<string, ProjectRecord>();

  create(input: CreateProjectInput): ProjectRecord {
    const now = Date.now();
    const record: ProjectRecord = {
      id: input.id ?? randomUUID(),
      name: input.name,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      version: 0,
      timelineRevision: 0,
      createdAt: now,
      updatedAt: now,
      source: input.source,
      width: input.width,
      height: input.height,
    };
    this.rows.set(record.id, clone(record));
    return clone(record);
  }

  get(id: string): ProjectRecord | undefined {
    const r = this.rows.get(id);
    return r ? clone(r) : undefined;
  }

  list(): ProjectRecord[] {
    return [...this.rows.values()].map(clone);
  }

  update(id: string, patch: ProjectPatch, expectedVersion?: number): ProjectRecord {
    const current = this.rows.get(id);
    if (!current) throw new ProjectNotFoundError(id);
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new ConcurrencyError(id, expectedVersion, current.version);
    }
    const next: ProjectRecord = {
      ...current,
      name: patch.name ?? current.name,
      source: patch.source ?? current.source,
      width: patch.width === undefined ? current.width : patch.width,
      height: patch.height === undefined ? current.height : patch.height,
      timelineRevision:
        patch.timelineRevision === undefined ? current.timelineRevision : patch.timelineRevision,
      version: current.version + 1,
      updatedAt: Date.now(),
    };
    this.rows.set(id, clone(next));
    return clone(next);
  }

  delete(id: string): void {
    this.rows.delete(id);
  }
}

class MemoryTimelineRepository implements TimelineRepository {
  private states = new Map<string, PersistedTimelineState>();
  private pending = new Map<string, EditPlan>();
  private logs = new Map<string, OperationLogEntry[]>();

  save(projectId: string, state: PersistedTimelineState): void {
    this.states.set(projectId, clone(state));
  }
  load(projectId: string): PersistedTimelineState | undefined {
    const s = this.states.get(projectId);
    return s ? clone(s) : undefined;
  }
  savePendingPlan(projectId: string, plan: EditPlan | null): void {
    if (plan) this.pending.set(projectId, clone(plan));
    else this.pending.delete(projectId);
  }
  loadPendingPlan(projectId: string): EditPlan | null {
    const p = this.pending.get(projectId);
    return p ? clone(p) : null;
  }
  appendOperation(entry: OperationLogEntry): void {
    const list = this.logs.get(entry.projectId) ?? [];
    list.push(clone(entry));
    this.logs.set(entry.projectId, list);
  }
  operations(projectId: string): OperationLogEntry[] {
    return (this.logs.get(projectId) ?? []).map(clone);
  }
  deleteForProject(projectId: string): void {
    this.states.delete(projectId);
    this.pending.delete(projectId);
    this.logs.delete(projectId);
  }
}

class MemoryMediaRepository implements MediaRepository {
  private assets = new Map<string, MediaAsset>();

  addAsset(asset: MediaAsset): void {
    this.assets.set(asset.id, clone(asset));
  }
  getAsset(id: string): MediaAsset | undefined {
    const a = this.assets.get(id);
    return a ? clone(a) : undefined;
  }
  getAssetByKind(projectId: string, kind: MediaAsset["kind"]): MediaAsset | undefined {
    return [...this.assets.values()]
      .filter((a) => a.projectId === projectId && a.kind === kind)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(clone)[0];
  }
  listAssets(projectId: string): MediaAsset[] {
    return [...this.assets.values()].filter((a) => a.projectId === projectId).map(clone);
  }
  deleteAsset(id: string): void {
    this.assets.delete(id);
  }
  deleteForProject(projectId: string): void {
    for (const [id, a] of this.assets) if (a.projectId === projectId) this.assets.delete(id);
  }
}

class MemoryAnalysisRepository implements AnalysisRepository {
  private rows = new Map<string, VideoAnalysis>();

  save(projectId: string, analysis: VideoAnalysis): void {
    this.rows.set(projectId, clone(analysis));
  }
  load(projectId: string): VideoAnalysis | undefined {
    const a = this.rows.get(projectId);
    return a ? clone(a) : undefined;
  }
  deleteForProject(projectId: string): void {
    this.rows.delete(projectId);
  }
}

class MemoryRunRepository implements RunRepository {
  private rows = new Map<string, RunRecord>();
  save(record: RunRecord): void {
    this.rows.set(record.id, clone(record));
  }
  get(id: string): RunRecord | undefined {
    const r = this.rows.get(id);
    return r ? clone(r) : undefined;
  }
  listByProject(projectId: string): RunRecord[] {
    return [...this.rows.values()]
      .filter((r) => r.projectId === projectId)
      .map(clone)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  deleteForProject(projectId: string): void {
    for (const [id, r] of this.rows) if (r.projectId === projectId) this.rows.delete(id);
  }
}

class MemoryIdempotencyRepository implements IdempotencyRepository {
  private rows = new Map<string, IdempotencyRecord>();

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
  }): IdempotencyClaim {
    const id = idempotencyRowId(input.projectId, input.capability, input.idempotencyKey);
    const existing = this.rows.get(id);
    if (existing) {
      if (existing.argsFingerprint !== input.argsFingerprint) {
        // Same key, different effect: refuse rather than silently overwrite.
        return { state: "in_progress", record: clone({ ...existing, status: "in_progress" }) };
      }
      if (existing.status === "completed") return { state: "completed", record: clone(existing) };
      if (existing.status === "failed") return { state: "failed", record: clone(existing) };
      if ((existing.leaseExpiresAt ?? 0) > input.now) {
        return { state: "in_progress", record: clone(existing) };
      }
      // The previous attempt's lease expired (process crashed) - reclaim it.
      const reclaimed: IdempotencyRecord = {
        ...existing,
        requestId: input.requestId,
        updatedAt: input.now,
        leaseExpiresAt: input.now + input.leaseMs,
      };
      this.rows.set(id, clone(reclaimed));
      return { state: "acquired", record: clone(reclaimed) };
    }
    const record: IdempotencyRecord = {
      id,
      projectId: input.projectId,
      capability: input.capability,
      idempotencyKey: input.idempotencyKey,
      requestId: input.requestId,
      argsFingerprint: input.argsFingerprint,
      status: "in_progress",
      errorCode: null,
      timelineRevision: null,
      aiosRunId: input.aiosRunId ?? null,
      aiosStepId: input.aiosStepId ?? null,
      createdAt: input.now,
      updatedAt: input.now,
      leaseExpiresAt: input.now + input.leaseMs,
    };
    this.rows.set(id, clone(record));
    return { state: "acquired", record: clone(record) };
  }

  complete(id: string, result: unknown, timelineRevision: number | null, now: number): void {
    const row = this.rows.get(id);
    if (!row) return;
    this.rows.set(id, clone({
      ...row,
      status: "completed",
      result,
      timelineRevision,
      updatedAt: now,
      leaseExpiresAt: null,
    }));
  }

  fail(id: string, errorCode: string, now: number): void {
    const row = this.rows.get(id);
    if (!row) return;
    this.rows.set(id, clone({ ...row, status: "failed", errorCode, updatedAt: now, leaseExpiresAt: null }));
  }

  release(id: string, now: number): void {
    const row = this.rows.get(id);
    if (!row || row.status !== "in_progress") return;
    this.rows.set(id, clone({ ...row, updatedAt: now, leaseExpiresAt: null }));
  }

  get(projectId: string, capability: string, idempotencyKey: string): IdempotencyRecord | undefined {
    const row = this.rows.get(idempotencyRowId(projectId, capability, idempotencyKey));
    return row ? clone(row) : undefined;
  }

  deleteForProject(projectId: string): void {
    for (const [id, row] of this.rows) if (row.projectId === projectId) this.rows.delete(id);
  }
}

class MemoryActivityRepository implements ActivityRepository {
  private rows: ActivityRecord[] = [];
  private sequences = new Map<string, number>();

  append(record: Omit<ActivityRecord, "sequence">): ActivityRecord {
    const sequence = (this.sequences.get(record.projectId) ?? 0) + 1;
    this.sequences.set(record.projectId, sequence);
    const full: ActivityRecord = { ...record, sequence };
    this.rows.push(clone(full));
    return clone(full);
  }

  list(projectId: string, options: { afterSequence?: number; limit?: number } = {}): ActivityRecord[] {
    return this.rows
      .filter((r) => r.projectId === projectId && r.sequence > (options.afterSequence ?? 0))
      .sort((a, b) => a.sequence - b.sequence)
      .slice(0, options.limit ?? 200)
      .map(clone);
  }

  deleteForProject(projectId: string): void {
    this.rows = this.rows.filter((r) => r.projectId !== projectId);
    this.sequences.delete(projectId);
  }
}

class MemoryAiosRunRepository implements AiosRunRepository {
  private rows = new Map<string, AiosRunRecord>();
  save(record: AiosRunRecord): void {
    this.rows.set(record.id, clone(record));
  }
  get(id: string): AiosRunRecord | undefined {
    const row = this.rows.get(id);
    return row ? clone(row) : undefined;
  }
  getByIdempotencyKey(key: string): AiosRunRecord | undefined {
    for (const row of this.rows.values()) if (row.idempotencyKey === key) return clone(row);
    return undefined;
  }
  listByProject(projectId: string): AiosRunRecord[] {
    return [...this.rows.values()]
      .filter((r) => r.projectId === projectId)
      .map(clone)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  deleteForProject(projectId: string): void {
    for (const [id, row] of this.rows) if (row.projectId === projectId) this.rows.delete(id);
  }
}

export function createMemoryRepositories(): Repositories {
  return {
    projects: new MemoryProjectRepository(),
    timelines: new MemoryTimelineRepository(),
    media: new MemoryMediaRepository(),
    analyses: new MemoryAnalysisRepository(),
    runs: new MemoryRunRepository(),
    idempotency: new MemoryIdempotencyRepository(),
    activity: new MemoryActivityRepository(),
    aiosRuns: new MemoryAiosRunRepository(),
  };
}

export function createMemoryProjectStore(): ProjectStore {
  return new ProjectStore(createMemoryRepositories());
}
