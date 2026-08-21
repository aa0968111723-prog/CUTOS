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
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_project ON agent_runs(projectId, createdAt);
    `);
  }

  if (from < 2) {
    // AIOS bridge durability. Written before the effect executes so a crashed
    // CUTOS still knows an apply/export was claimed and must not be re-run
    // blindly after restart.
    db.exec(`
      CREATE TABLE IF NOT EXISTS aios_idempotency (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        capability TEXT NOT NULL,
        idempotencyKey TEXT NOT NULL,
        requestId TEXT NOT NULL,
        argsFingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        errorCode TEXT,
        timelineRevision INTEGER,
        aiosRunId TEXT,
        aiosStepId TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        leaseExpiresAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_idem_project ON aios_idempotency(projectId, capability);
      CREATE TABLE IF NOT EXISTS aios_activity (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        messageKey TEXT NOT NULL,
        aiosRunId TEXT,
        aiosStepId TEXT,
        cutosAgentRunId TEXT,
        cutosJobId TEXT,
        metadata TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_seq ON aios_activity(projectId, sequence);
      CREATE TABLE IF NOT EXISTS aios_runs (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        aiosRunId TEXT,
        status TEXT NOT NULL,
        capability TEXT NOT NULL,
        goal TEXT NOT NULL,
        qualityProfile TEXT NOT NULL,
        requestId TEXT NOT NULL,
        idempotencyKey TEXT NOT NULL UNIQUE,
        state TEXT,
        errorCode TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_aios_runs_project ON aios_runs(projectId, createdAt);
    `);
  }

  // Future migrations: `if (from < 3) { ... }` etc.

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

class SqliteRunRepository implements RunRepository {
  constructor(private db: Db) {}

  save(record: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO agent_runs (id, projectId, createdAt, updatedAt, data)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updatedAt = excluded.updatedAt, data = excluded.data`,
      )
      .run(record.id, record.projectId, record.createdAt, record.updatedAt, JSON.stringify(record.data));
  }
  get(id: string): RunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(id) as unknown as
      | { id: string; projectId: string; createdAt: number; updatedAt: number; data: string }
      | undefined;
    return row ? { ...row, data: JSON.parse(row.data) as unknown } : undefined;
  }
  listByProject(projectId: string): RunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_runs WHERE projectId = ? ORDER BY createdAt DESC")
      .all(projectId) as unknown as {
      id: string;
      projectId: string;
      createdAt: number;
      updatedAt: number;
      data: string;
    }[];
    return rows.map((r) => ({ ...r, data: JSON.parse(r.data) as unknown }));
  }
  deleteForProject(projectId: string): void {
    this.db.prepare("DELETE FROM agent_runs WHERE projectId = ?").run(projectId);
  }
}

interface IdempotencyRow {
  id: string;
  projectId: string;
  capability: string;
  idempotencyKey: string;
  requestId: string;
  argsFingerprint: string;
  status: string;
  result: string | null;
  errorCode: string | null;
  timelineRevision: number | null;
  aiosRunId: string | null;
  aiosStepId: string | null;
  createdAt: number;
  updatedAt: number;
  leaseExpiresAt: number | null;
}

function rowToIdempotency(row: IdempotencyRow): IdempotencyRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    capability: row.capability,
    idempotencyKey: row.idempotencyKey,
    requestId: row.requestId,
    argsFingerprint: row.argsFingerprint,
    status: row.status as IdempotencyRecord["status"],
    result: row.result == null ? undefined : (JSON.parse(row.result) as unknown),
    errorCode: row.errorCode,
    timelineRevision: row.timelineRevision,
    aiosRunId: row.aiosRunId,
    aiosStepId: row.aiosStepId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    leaseExpiresAt: row.leaseExpiresAt,
  };
}

class SqliteIdempotencyRepository implements IdempotencyRepository {
  constructor(private db: Db) {}

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
    // INSERT-or-nothing is the atomic claim: two concurrent attempts cannot
    // both believe they own the effect.
    const inserted = this.db
      .prepare(
        `INSERT INTO aios_idempotency
           (id, projectId, capability, idempotencyKey, requestId, argsFingerprint, status,
            result, errorCode, timelineRevision, aiosRunId, aiosStepId, createdAt, updatedAt, leaseExpiresAt)
         VALUES (?, ?, ?, ?, ?, ?, 'in_progress', NULL, NULL, NULL, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        id,
        input.projectId,
        input.capability,
        input.idempotencyKey,
        input.requestId,
        input.argsFingerprint,
        input.aiosRunId ?? null,
        input.aiosStepId ?? null,
        input.now,
        input.now,
        input.now + input.leaseMs,
      );

    const row = this.db
      .prepare("SELECT * FROM aios_idempotency WHERE id = ?")
      .get(id) as unknown as IdempotencyRow;
    const record = rowToIdempotency(row);

    if (Number(inserted.changes) === 1) return { state: "acquired", record };
    if (record.argsFingerprint !== input.argsFingerprint) {
      return { state: "in_progress", record };
    }
    if (record.status === "completed") return { state: "completed", record };
    if (record.status === "failed") return { state: "failed", record };
    if ((record.leaseExpiresAt ?? 0) > input.now) return { state: "in_progress", record };

    const reclaimed = this.db
      .prepare(
        `UPDATE aios_idempotency
            SET requestId = ?, updatedAt = ?, leaseExpiresAt = ?
          WHERE id = ? AND status = 'in_progress'
            AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ?)`,
      )
      .run(input.requestId, input.now, input.now + input.leaseMs, id, input.now);
    if (Number(reclaimed.changes) !== 1) return { state: "in_progress", record };
    const fresh = this.db
      .prepare("SELECT * FROM aios_idempotency WHERE id = ?")
      .get(id) as unknown as IdempotencyRow;
    // `reclaimed`, not `acquired`: this key belonged to an attempt that died
    // mid-effect. Reporting it as fresh is what made the caller re-apply an
    // edit and re-render an export after a restart — the exact failure this
    // table's docstring promises it prevents.
    return {
      state: "reclaimed",
      record: rowToIdempotency(fresh),
      // `record` already carries the NEW requestId; the dead attempt's id is
      // captured from the row read before the reclaim update.
      previousRequestId: record.requestId,
    };
  }

  complete(id: string, result: unknown, timelineRevision: number | null, now: number): void {
    this.db
      .prepare(
        `UPDATE aios_idempotency
            SET status = 'completed', result = ?, timelineRevision = ?, updatedAt = ?, leaseExpiresAt = NULL
          WHERE id = ?`,
      )
      .run(JSON.stringify(result ?? null), timelineRevision, now, id);
  }

  fail(id: string, errorCode: string, now: number): void {
    this.db
      .prepare(
        `UPDATE aios_idempotency
            SET status = 'failed', errorCode = ?, updatedAt = ?, leaseExpiresAt = NULL
          WHERE id = ?`,
      )
      .run(errorCode, now, id);
  }

  /**
   * Give the key back when the caller KNOWS the effect did not run.
   *
   * Deleted, not merely un-leased: an expired lease means "an attempt died and
   * we do not know what it did" and the next claim must report `reclaimed`,
   * while an explicit release is positive evidence that nothing happened. A
   * released row left in place would make every later attempt on that key look
   * like crash recovery forever.
   */
  release(id: string, _now: number): void {
    this.db
      .prepare("DELETE FROM aios_idempotency WHERE id = ? AND status = 'in_progress'")
      .run(id);
  }

  get(projectId: string, capability: string, idempotencyKey: string): IdempotencyRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM aios_idempotency WHERE id = ?")
      .get(idempotencyRowId(projectId, capability, idempotencyKey)) as unknown as
      | IdempotencyRow
      | undefined;
    return row ? rowToIdempotency(row) : undefined;
  }

  deleteForProject(projectId: string): void {
    this.db.prepare("DELETE FROM aios_idempotency WHERE projectId = ?").run(projectId);
  }
}

interface ActivityRow {
  id: string;
  projectId: string;
  sequence: number;
  at: number;
  kind: string;
  status: string;
  messageKey: string;
  aiosRunId: string | null;
  aiosStepId: string | null;
  cutosAgentRunId: string | null;
  cutosJobId: string | null;
  metadata: string;
}

function rowToActivity(row: ActivityRow): ActivityRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    sequence: row.sequence,
    at: row.at,
    kind: row.kind,
    status: row.status,
    messageKey: row.messageKey,
    aiosRunId: row.aiosRunId,
    aiosStepId: row.aiosStepId,
    cutosAgentRunId: row.cutosAgentRunId,
    cutosJobId: row.cutosJobId,
    metadata: JSON.parse(row.metadata) as ActivityRecord["metadata"],
  };
}

class SqliteActivityRepository implements ActivityRepository {
  constructor(private db: Db) {}

  append(record: Omit<ActivityRecord, "sequence">): ActivityRecord {
    const row = this.db
      .prepare("SELECT MAX(sequence) AS maxSequence FROM aios_activity WHERE projectId = ?")
      .get(record.projectId) as unknown as { maxSequence: number | null };
    const sequence = (row?.maxSequence ?? 0) + 1;
    this.db
      .prepare(
        `INSERT INTO aios_activity
           (id, projectId, sequence, at, kind, status, messageKey, aiosRunId, aiosStepId, cutosAgentRunId, cutosJobId, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.projectId,
        sequence,
        record.at,
        record.kind,
        record.status,
        record.messageKey,
        record.aiosRunId,
        record.aiosStepId,
        record.cutosAgentRunId,
        record.cutosJobId,
        JSON.stringify(record.metadata),
      );
    return { ...record, sequence };
  }

  list(projectId: string, options: { afterSequence?: number; limit?: number } = {}): ActivityRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM aios_activity WHERE projectId = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?",
      )
      .all(projectId, options.afterSequence ?? 0, options.limit ?? 200) as unknown as ActivityRow[];
    return rows.map(rowToActivity);
  }

  deleteForProject(projectId: string): void {
    this.db.prepare("DELETE FROM aios_activity WHERE projectId = ?").run(projectId);
  }
}

interface AiosRunRow {
  id: string;
  projectId: string;
  aiosRunId: string | null;
  status: string;
  capability: string;
  goal: string;
  qualityProfile: string;
  requestId: string;
  idempotencyKey: string;
  state: string | null;
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
}

function rowToAiosRun(row: AiosRunRow): AiosRunRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    aiosRunId: row.aiosRunId,
    status: row.status as AiosRunRecord["status"],
    capability: row.capability,
    goal: row.goal,
    qualityProfile: row.qualityProfile,
    requestId: row.requestId,
    idempotencyKey: row.idempotencyKey,
    state: row.state == null ? undefined : (JSON.parse(row.state) as unknown),
    errorCode: row.errorCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

class SqliteAiosRunRepository implements AiosRunRepository {
  constructor(private db: Db) {}

  save(record: AiosRunRecord): void {
    this.db
      .prepare(
        `INSERT INTO aios_runs
           (id, projectId, aiosRunId, status, capability, goal, qualityProfile, requestId, idempotencyKey, state, errorCode, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           aiosRunId = excluded.aiosRunId,
           status = excluded.status,
           state = excluded.state,
           errorCode = excluded.errorCode,
           updatedAt = excluded.updatedAt`,
      )
      .run(
        record.id,
        record.projectId,
        record.aiosRunId,
        record.status,
        record.capability,
        record.goal,
        record.qualityProfile,
        record.requestId,
        record.idempotencyKey,
        record.state === undefined ? null : JSON.stringify(record.state),
        record.errorCode,
        record.createdAt,
        record.updatedAt,
      );
  }

  get(id: string): AiosRunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM aios_runs WHERE id = ?").get(id) as unknown as
      | AiosRunRow
      | undefined;
    return row ? rowToAiosRun(row) : undefined;
  }

  getByIdempotencyKey(key: string): AiosRunRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM aios_runs WHERE idempotencyKey = ?")
      .get(key) as unknown as AiosRunRow | undefined;
    return row ? rowToAiosRun(row) : undefined;
  }

  listByProject(projectId: string): AiosRunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM aios_runs WHERE projectId = ? ORDER BY createdAt DESC")
      .all(projectId) as unknown as AiosRunRow[];
    return rows.map(rowToAiosRun);
  }

  deleteForProject(projectId: string): void {
    this.db.prepare("DELETE FROM aios_runs WHERE projectId = ?").run(projectId);
  }
}

export function createSqliteRepositories(filename: string): Repositories & { close: () => void } {
  const db = openDatabase(filename);
  return {
    projects: new SqliteProjectRepository(db),
    timelines: new SqliteTimelineRepository(db),
    media: new SqliteMediaRepository(db),
    analyses: new SqliteAnalysisRepository(db),
    runs: new SqliteRunRepository(db),
    idempotency: new SqliteIdempotencyRepository(db),
    activity: new SqliteActivityRepository(db),
    aiosRuns: new SqliteAiosRunRepository(db),
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
