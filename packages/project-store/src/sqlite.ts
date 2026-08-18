import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { EditPlan } from "@cutos/edit-dsl";
import { ProjectStore, type Repositories } from "./facade.js";
import {
  CURRENT_SCHEMA_VERSION,
  ConcurrencyError,
  PersistedTimelineStateSchema,
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
  type TimelineRepository,
  type VideoAnalysis,
} from "./types.js";

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

type Db = DatabaseSyncType;

/** Open the database and run schema migrations up to CURRENT_SCHEMA_VERSION. */
function openDatabase(filename: string): Db {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as
    | { value: string }
    | undefined;
  const from = row ? Number.parseInt(row.value, 10) : 0;

  if (from < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        schemaVersion INTEGER NOT NULL,
        version INTEGER NOT NULL,
        timelineRevision INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        source TEXT NOT NULL,
        width INTEGER,
        height INTEGER
      );
      CREATE TABLE IF NOT EXISTS timeline_state (
        projectId TEXT PRIMARY KEY,
        state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_plans (
        projectId TEXT PRIMARY KEY,
        plan TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operation_log (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        at INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        kind TEXT NOT NULL,
        planId TEXT,
        summary TEXT,
        operationCount INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_oplog_project ON operation_log(projectId, at);
      CREATE TABLE IF NOT EXISTS media_assets (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_assets_project ON media_assets(projectId);
      CREATE TABLE IF NOT EXISTS analyses (
        projectId TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
    `);
  }

  // Future migrations: `if (from < 2) { ... }` etc.

  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('schemaVersion', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(CURRENT_SCHEMA_VERSION));
}

interface ProjectRow {
  id: string;
  name: string;
  schemaVersion: number;
  version: number;
  timelineRevision: number;
  createdAt: number;
  updatedAt: number;
  source: string;
  width: number | null;
  height: number | null;
}

function rowToProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    schemaVersion: row.schemaVersion,
    version: row.version,
    timelineRevision: row.timelineRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    source: JSON.parse(row.source) as ProjectRecord["source"],
    width: row.width,
    height: row.height,
  };
}

class SqliteProjectRepository implements ProjectRepository {
  constructor(private db: Db) {}

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
    this.db
      .prepare(
        `INSERT INTO projects (id, name, schemaVersion, version, timelineRevision, createdAt, updatedAt, source, width, height)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.name,
        record.schemaVersion,
        record.version,
        record.timelineRevision,
        record.createdAt,
        record.updatedAt,
        JSON.stringify(record.source),
        record.width,
        record.height,
      );
    return record;
  }

  get(id: string): ProjectRecord | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as unknown as
      | ProjectRow
      | undefined;
    return row ? rowToProject(row) : undefined;
  }

  list(): ProjectRecord[] {
    const rows = this.db.prepare("SELECT * FROM projects").all() as unknown as ProjectRow[];
    return rows.map(rowToProject);
  }

  update(id: string, patch: ProjectPatch, expectedVersion?: number): ProjectRecord {
    const current = this.get(id);
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
    this.db
      .prepare(
        `UPDATE projects SET name=?, source=?, width=?, height=?, timelineRevision=?, version=?, updatedAt=? WHERE id=?`,
      )
      .run(
        next.name,
        JSON.stringify(next.source),
        next.width,
        next.height,
        next.timelineRevision,
        next.version,
        next.updatedAt,
        id,
      );
    return next;
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }
}

class SqliteTimelineRepository implements TimelineRepository {
  constructor(private db: Db) {}

  save(projectId: string, state: PersistedTimelineState): void {
    this.db
      .prepare(
        "INSERT INTO timeline_state (projectId, state) VALUES (?, ?) ON CONFLICT(projectId) DO UPDATE SET state = excluded.state",
      )
      .run(projectId, JSON.stringify(state));
  }

  load(projectId: string): PersistedTimelineState | undefined {
    const row = this.db.prepare("SELECT state FROM timeline_state WHERE projectId = ?").get(projectId) as
      | { state: string }
      | undefined;
    if (!row) return undefined;
    return PersistedTimelineStateSchema.parse(JSON.parse(row.state));
  }

  savePendingPlan(projectId: string, plan: EditPlan | null): void {
    if (!plan) {
      this.db.prepare("DELETE FROM pending_plans WHERE projectId = ?").run(projectId);
      return;
    }
    this.db
      .prepare(
        "INSERT INTO pending_plans (projectId, plan) VALUES (?, ?) ON CONFLICT(projectId) DO UPDATE SET plan = excluded.plan",
      )
      .run(projectId, JSON.stringify(plan));
  }

  loadPendingPlan(projectId: string): EditPlan | null {
    const row = this.db.prepare("SELECT plan FROM pending_plans WHERE projectId = ?").get(projectId) as
      | { plan: string }
      | undefined;
    return row ? (JSON.parse(row.plan) as EditPlan) : null;
  }

  appendOperation(entry: OperationLogEntry): void {
    this.db
      .prepare(
        `INSERT INTO operation_log (id, projectId, at, revision, kind, planId, summary, operationCount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.projectId,
        entry.at,
        entry.revision,
        entry.kind,
        entry.planId,
        entry.summary,
        entry.operationCount,
      );
  }

  operations(projectId: string): OperationLogEntry[] {
    return this.db
      .prepare("SELECT * FROM operation_log WHERE projectId = ? ORDER BY at ASC")
      .all(projectId) as unknown as OperationLogEntry[];
  }

  deleteForProject(projectId: string): void {
    this.db.prepare("DELETE FROM timeline_state WHERE projectId = ?").run(projectId);
    this.db.prepare("DELETE FROM pending_plans WHERE projectId = ?").run(projectId);
    this.db.prepare("DELETE FROM operation_log WHERE projectId = ?").run(projectId);
  }
}

class SqliteMediaRepository implements MediaRepository {
  constructor(private db: Db) {}

  addAsset(asset: MediaAsset): void {
    this.db
      .prepare(
        "INSERT INTO media_assets (id, projectId, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
      )
      .run(asset.id, asset.projectId, JSON.stringify(asset));
  }
  getAsset(id: string): MediaAsset | undefined {
    const row = this.db.prepare("SELECT data FROM media_assets WHERE id = ?").get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as MediaAsset) : undefined;
  }
  getAssetByKind(projectId: string, kind: MediaAsset["kind"]): MediaAsset | undefined {
    return this.listAssets(projectId)
      .filter((a) => a.kind === kind)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
  }
  listAssets(projectId: string): MediaAsset[] {
    const rows = this.db
      .prepare("SELECT data FROM media_assets WHERE projectId = ?")
      .all(projectId) as unknown as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as MediaAsset);
  }
  deleteAsset(id: string): void {
    this.db.prepare("DELETE FROM media_assets WHERE id = ?").run(id);
  }
  deleteForProject(projectId: string): void {
    this.db.prepare("DELETE FROM media_assets WHERE projectId = ?").run(projectId);
  }
}

class SqliteAnalysisRepository implements AnalysisRepository {
  constructor(private db: Db) {}

  save(projectId: string, analysis: VideoAnalysis): void {
    this.db
      .prepare(
        "INSERT INTO analyses (projectId, data) VALUES (?, ?) ON CONFLICT(projectId) DO UPDATE SET data = excluded.data",
      )
      .run(projectId, JSON.stringify(analysis));
  }
  load(projectId: string): VideoAnalysis | undefined {
    const row = this.db.prepare("SELECT data FROM analyses WHERE projectId = ?").get(projectId) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as VideoAnalysis) : undefined;
  }
  deleteForProject(projectId: string): void {
    this.db.prepare("DELETE FROM analyses WHERE projectId = ?").run(projectId);
  }
}

export function createSqliteRepositories(filename: string): Repositories & { close: () => void } {
  const db = openDatabase(filename);
  return {
    projects: new SqliteProjectRepository(db),
    timelines: new SqliteTimelineRepository(db),
    media: new SqliteMediaRepository(db),
    analyses: new SqliteAnalysisRepository(db),
    close: () => db.close(),
  };
}

/** A ProjectStore backed by durable SQLite. `close()` releases the DB handle. */
export class SqliteProjectStore extends ProjectStore {
  private readonly _close: () => void;
  constructor(filename: string) {
    const repos = createSqliteRepositories(filename);
    super(repos);
    this._close = repos.close;
  }
  close(): void {
    this._close();
  }
}

export function createSqliteProjectStore(filename: string): SqliteProjectStore {
  return new SqliteProjectStore(filename);
}
