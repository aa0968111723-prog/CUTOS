import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { BaseJobStore } from "./base-store.js";
import type { Job } from "./types.js";

// Load `node:sqlite` through Node's require at runtime. A static `import` is
// rejected by bundlers (Vite/webpack) that don't yet know this newer builtin.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};

interface JobRow {
  id: string;
  kind: string;
  projectId: string | null;
  status: string;
  progress: number;
  stage: string | null;
  attempt: number;
  maxAttempts: number;
  payload: string;
  result: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  heartbeatAt: number | null;
  cancelRequested: number;
}

/**
 * Durable SQLite-backed job store using Node's built-in `node:sqlite`. Job
 * metadata survives process restarts, which (together with `recoverStale`) is
 * what makes worker crash recovery possible.
 */
export class SqliteJobStore extends BaseJobStore {
  private db: DatabaseSyncType;

  constructor(filename = ":memory:") {
    super();
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        projectId TEXT,
        status TEXT NOT NULL,
        progress REAL NOT NULL,
        stage TEXT,
        attempt INTEGER NOT NULL,
        maxAttempts INTEGER NOT NULL,
        payload TEXT NOT NULL,
        result TEXT,
        error TEXT,
        createdAt INTEGER NOT NULL,
        startedAt INTEGER,
        finishedAt INTEGER,
        heartbeatAt INTEGER,
        cancelRequested INTEGER NOT NULL
      );
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, createdAt);");
  }

  protected insert(job: Job): void {
    this.save(job);
  }

  protected save(job: Job): void {
    this.db
      .prepare(
        `INSERT INTO jobs (id, kind, projectId, status, progress, stage, attempt, maxAttempts,
          payload, result, error, createdAt, startedAt, finishedAt, heartbeatAt, cancelRequested)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind=excluded.kind, projectId=excluded.projectId, status=excluded.status,
           progress=excluded.progress, stage=excluded.stage, attempt=excluded.attempt,
           maxAttempts=excluded.maxAttempts, payload=excluded.payload, result=excluded.result,
           error=excluded.error, createdAt=excluded.createdAt, startedAt=excluded.startedAt,
           finishedAt=excluded.finishedAt, heartbeatAt=excluded.heartbeatAt,
           cancelRequested=excluded.cancelRequested`,
      )
      .run(
        job.id,
        job.kind,
        job.projectId,
        job.status,
        job.progress,
        job.stage,
        job.attempt,
        job.maxAttempts,
        JSON.stringify(job.payload ?? null),
        job.result === null ? null : JSON.stringify(job.result),
        job.error,
        job.createdAt,
        job.startedAt,
        job.finishedAt,
        job.heartbeatAt,
        job.cancelRequested ? 1 : 0,
      );
  }

  protected read(id: string): Job | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as unknown as
      | JobRow
      | undefined;
    return row ? rowToJob(row) : undefined;
  }

  protected all(): Job[] {
    const rows = this.db.prepare("SELECT * FROM jobs").all() as unknown as JobRow[];
    return rows.map(rowToJob);
  }

  clear(): void {
    this.db.exec("DELETE FROM jobs;");
  }

  close(): void {
    this.db.close();
  }
}

function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    kind: row.kind,
    projectId: row.projectId,
    status: row.status as Job["status"],
    progress: row.progress,
    stage: row.stage,
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    payload: JSON.parse(row.payload) as unknown,
    result: row.result === null ? null : (JSON.parse(row.result) as unknown),
    error: row.error,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    heartbeatAt: row.heartbeatAt,
    cancelRequested: row.cancelRequested === 1,
  };
}
