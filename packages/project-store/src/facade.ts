import { randomUUID } from "node:crypto";
import type { EditPlan } from "@cutos/edit-dsl";
import { createTimeline } from "@cutos/timeline";
import type {
  AnalysisRepository,
  CreateProjectInput,
  MediaAsset,
  MediaRepository,
  OperationLogEntry,
  PersistedTimelineState,
  ProjectPatch,
  ProjectRecord,
  ProjectRepository,
  RunRecord,
  RunRepository,
  TimelineRepository,
  VideoAnalysis,
} from "./types.js";
import { ProjectNotFoundError } from "./types.js";

export interface Repositories {
  projects: ProjectRepository;
  timelines: TimelineRepository;
  media: MediaRepository;
  analyses: AnalysisRepository;
  runs: RunRepository;
}

/**
 * Facade over the four repositories. It exposes the durable project API used by
 * the application and enforces cross-repository invariants (autosave via
 * updatedAt/version bumps, cascading delete, timeline revision tracking). All
 * mutating calls persist immediately — there is no in-memory-only source of
 * truth.
 */
export class ProjectStore {
  constructor(private readonly repos: Repositories) {}

  get media(): MediaRepository {
    return this.repos.media;
  }

  // --- projects ---

  createProject(input: CreateProjectInput): ProjectRecord {
    const record = this.repos.projects.create(input);
    const initial: PersistedTimelineState = {
      revision: 0,
      current: createTimeline(record.source),
      past: [],
      future: [],
    };
    this.repos.timelines.save(record.id, initial);
    return record;
  }

  getProject(id: string): ProjectRecord | undefined {
    return this.repos.projects.get(id);
  }

  requireProject(id: string): ProjectRecord {
    const record = this.repos.projects.get(id);
    if (!record) throw new ProjectNotFoundError(id);
    return record;
  }

  listProjects(): ProjectRecord[] {
    return [...this.repos.projects.list()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  updateProject(id: string, patch: ProjectPatch, expectedVersion?: number): ProjectRecord {
    return this.repos.projects.update(id, patch, expectedVersion);
  }

  deleteProject(id: string): void {
    this.repos.timelines.deleteForProject(id);
    this.repos.media.deleteForProject(id);
    this.repos.analyses.deleteForProject(id);
    this.repos.runs.deleteForProject(id);
    this.repos.projects.delete(id);
  }

  // --- agent runs (opaque records) ---

  saveRun(record: RunRecord): void {
    this.repos.runs.save(record);
  }
  getRun(id: string): RunRecord | undefined {
    return this.repos.runs.get(id);
  }
  listRuns(projectId: string): RunRecord[] {
    return this.repos.runs.listByProject(projectId);
  }

  // --- timeline ---

  saveTimeline(projectId: string, state: PersistedTimelineState, expectedVersion?: number): ProjectRecord {
    this.requireProject(projectId);
    // Optimistic concurrency check happens on the project record update.
    const record = this.repos.projects.update(
      projectId,
      { timelineRevision: state.revision },
      expectedVersion,
    );
    this.repos.timelines.save(projectId, state);
    return record;
  }

  loadTimeline(projectId: string): PersistedTimelineState | undefined {
    return this.repos.timelines.load(projectId);
  }

  savePendingPlan(projectId: string, plan: EditPlan | null): void {
    this.requireProject(projectId);
    this.repos.timelines.savePendingPlan(projectId, plan);
  }

  loadPendingPlan(projectId: string): EditPlan | null {
    return this.repos.timelines.loadPendingPlan(projectId);
  }

  appendOperation(entry: Omit<OperationLogEntry, "id">): OperationLogEntry {
    const full: OperationLogEntry = { id: randomUUID(), ...entry };
    this.repos.timelines.appendOperation(full);
    return full;
  }

  operations(projectId: string): OperationLogEntry[] {
    return this.repos.timelines.operations(projectId);
  }

  // --- analysis ---

  saveAnalysis(projectId: string, analysis: VideoAnalysis): void {
    this.requireProject(projectId);
    this.repos.analyses.save(projectId, analysis);
    this.repos.projects.update(projectId, {});
  }

  loadAnalysis(projectId: string): VideoAnalysis | undefined {
    return this.repos.analyses.load(projectId);
  }

  // --- media assets ---

  addAsset(asset: MediaAsset): void {
    this.repos.media.addAsset(asset);
  }

  listAssets(projectId: string): MediaAsset[] {
    return this.repos.media.listAssets(projectId);
  }

  getAssetByKind(projectId: string, kind: MediaAsset["kind"]): MediaAsset | undefined {
    return this.repos.media.getAssetByKind(projectId, kind);
  }
}
