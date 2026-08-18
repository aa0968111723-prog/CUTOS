import { randomUUID } from "node:crypto";
import type { EditPlan } from "@cutos/edit-dsl";
import type { SilenceInterval } from "@cutos/media";
import {
  TimelineHistory,
  createTimeline,
  type SourceMedia,
} from "@cutos/timeline";

export interface Analysis {
  thresholdDb: number;
  minSilenceMs: number;
  silences: SilenceInterval[];
}

export interface OutputInfo {
  path: string;
  durationMs: number;
  createdAtMs: number;
}

export interface ProjectRecord {
  id: string;
  name: string;
  createdAtMs: number;
  source: SourceMedia;
  sourcePath: string;
  width: number | null;
  height: number | null;
  analysis?: Analysis;
  history: TimelineHistory;
  /** A proposed-but-not-yet-applied plan awaiting user review. */
  pendingPlan?: EditPlan;
  output?: OutputInfo;
}

export interface CreateProjectInput {
  name: string;
  source: SourceMedia;
  sourcePath: string;
  width: number | null;
  height: number | null;
}

class ProjectStore {
  private projects = new Map<string, ProjectRecord>();

  create(input: CreateProjectInput): ProjectRecord {
    const id = randomUUID();
    const record: ProjectRecord = {
      id,
      name: input.name,
      createdAtMs: Date.now(),
      source: input.source,
      sourcePath: input.sourcePath,
      width: input.width,
      height: input.height,
      history: new TimelineHistory(createTimeline(input.source)),
    };
    this.projects.set(id, record);
    return record;
  }

  get(id: string): ProjectRecord | undefined {
    return this.projects.get(id);
  }

  require(id: string): ProjectRecord {
    const record = this.projects.get(id);
    if (!record) {
      throw new ProjectNotFoundError(id);
    }
    return record;
  }
}

export class ProjectNotFoundError extends Error {
  constructor(id: string) {
    super(`Project ${id} not found`);
    this.name = "ProjectNotFoundError";
  }
}

const globalRef = globalThis as unknown as { __cutosStore?: ProjectStore };
export const store: ProjectStore = (globalRef.__cutosStore ??= new ProjectStore());
