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
  type RunRecord,
  type RunRepository,
  type TimelineRepository,
  type VideoAnalysis,
} from "./types.js";

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

export function createMemoryRepositories(): Repositories {
  return {
    projects: new MemoryProjectRepository(),
    timelines: new MemoryTimelineRepository(),
    media: new MemoryMediaRepository(),
    analyses: new MemoryAnalysisRepository(),
    runs: new MemoryRunRepository(),
  };
}

export function createMemoryProjectStore(): ProjectStore {
  return new ProjectStore(createMemoryRepositories());
}
