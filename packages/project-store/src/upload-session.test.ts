import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryProjectStore } from "./memory.js";
import { SqliteProjectStore } from "./sqlite.js";
import type { ProjectStore } from "./facade.js";
import type { UploadSessionRecord } from "./types.js";

// `node:sqlite` is a built-in Vite's resolver does not know; require it the
// same way the store does.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...params: unknown[]): unknown };
    close(): void;
  };
};

const source = { id: "src_1", uri: "storage://sources/x/original.mp4", durationMs: 0, hasAudio: true };

function session(overrides: Partial<UploadSessionRecord> = {}): UploadSessionRecord {
  return {
    id: "up_1",
    status: "pending",
    filename: "clip.mp4",
    declaredBytes: 1_000,
    declaredMime: "video/mp4",
    receivedBytes: 0,
    storageKey: "uploads/up_1/blob",
    checksum: null,
    projectId: null,
    assetId: null,
    errorCode: null,
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 10_000,
    ...overrides,
  };
}

/** Both backends must behave identically; the app only sees the facade. */
function behavesLikeAnUploadStore(name: string, make: () => ProjectStore) {
  describe(`upload sessions (${name})`, () => {
    it("records accepted bytes so a resumed upload knows where to continue", () => {
      const store = make();
      store.uploads.create(session());
      store.uploads.update("up_1", { status: "uploading", receivedBytes: 640 });
      expect(store.uploads.get("up_1")?.receivedBytes).toBe(640);
      expect(store.uploads.get("up_1")?.status).toBe("uploading");
    });

    it("finalizes exactly once, and replays the same project on a duplicate", () => {
      const store = make();
      store.uploads.create(session({ status: "complete", receivedBytes: 1_000 }));

      const first = store.uploads.claimFinalize("up_1", "proj_a", "asset_a", "abc", 5);
      expect(first.claimed).toBe(true);

      // A retried finalize (double-tap, reconnect, background/foreground churn)
      // must NOT produce a second project.
      const second = store.uploads.claimFinalize("up_1", "proj_b", "asset_b", "abc", 6);
      expect(second.claimed).toBe(false);
      expect(second.record.projectId).toBe("proj_a");
      expect(store.uploads.get("up_1")?.projectId).toBe("proj_a");
    });

    it("lists expired sessions for sweeping but never a finalized one", () => {
      const store = make();
      store.uploads.create(session({ id: "up_stale", expiresAt: 100 }));
      store.uploads.create(session({ id: "up_live", expiresAt: 9_999 }));
      store.uploads.create(session({ id: "up_done", expiresAt: 100, status: "finalized" }));

      const expired = store.uploads.listExpired(500).map((r) => r.id);
      expect(expired).toContain("up_stale");
      expect(expired).not.toContain("up_live");
      expect(expired).not.toContain("up_done");
    });

    it("tracks media status separately from the timeline", () => {
      const store = make();
      const project = store.createProject({
        name: "Uploaded",
        source,
        width: null,
        height: null,
        mediaStatus: "uploaded",
      });
      expect(project.mediaStatus).toBe("uploaded");
      expect(store.updateProject(project.id, { mediaStatus: "probing" }).mediaStatus).toBe("probing");
      const failed = store.updateProject(project.id, {
        mediaStatus: "failed",
        mediaError: "PROBE_FAILED",
      });
      expect(failed.mediaError).toBe("PROBE_FAILED");
      // Retrying the probe clears the error without touching the asset.
      expect(store.updateProject(project.id, { mediaStatus: "probing", mediaError: null }).mediaError).toBe(
        null,
      );
    });

    it("defaults server-side imports to ready so existing flows are unchanged", () => {
      const store = make();
      const project = store.createProject({ name: "Demo", source, width: null, height: null });
      expect(project.mediaStatus).toBe("ready");
      expect(project.mediaError).toBe(null);
    });
  });
}

behavesLikeAnUploadStore("memory", createMemoryProjectStore);

describe("sqlite upload sessions", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeFile(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "cutos-uploads-"));
    dirs.push(dir);
    return join(dir, "cutos.db");
  }

  it("keeps sessions and media status across a restart", async () => {
    const file = await makeFile();
    const first = new SqliteProjectStore(file);
    first.uploads.create(session({ status: "uploading", receivedBytes: 512 }));
    const project = first.createProject({
      name: "Half-probed",
      source,
      width: null,
      height: null,
      mediaStatus: "probing",
    });
    first.close();

    const second = new SqliteProjectStore(file);
    expect(second.uploads.get("up_1")?.receivedBytes).toBe(512);
    expect(second.getProject(project.id)?.mediaStatus).toBe("probing");
    second.close();
  });

  it("migrates a v2 database in place, treating existing media as ready", async () => {
    const file = await makeFile();
    // Hand-build the v2 shape: projects without the media columns.
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    db.exec(`CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, schemaVersion INTEGER NOT NULL,
      version INTEGER NOT NULL, timelineRevision INTEGER NOT NULL,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
      source TEXT NOT NULL, width INTEGER, height INTEGER);`);
    db.prepare("INSERT INTO meta (key, value) VALUES ('schemaVersion', '2')").run();
    db.prepare(
      `INSERT INTO projects VALUES ('old', 'Legacy', 2, 3, 1, 100, 200, ?, 1920, 1080)`,
    ).run(JSON.stringify({ ...source, durationMs: 12_000 }));
    db.close();

    const store = new SqliteProjectStore(file);
    const legacy = store.getProject("old");
    expect(legacy?.name).toBe("Legacy");
    // Pre-streaming projects were probed inside the request, so their media is
    // already readable — they must not appear stuck in "processing".
    expect(legacy?.mediaStatus).toBe("ready");
    expect(legacy?.mediaError).toBe(null);
    // And the new table is available.
    store.uploads.create(session());
    expect(store.uploads.get("up_1")?.status).toBe("pending");
    store.close();
  });
});

behavesLikeAnUploadStore("sqlite-in-memory-file", () => {
  // A per-call temp file keeps the shared suite backend-agnostic.
  const file = join(tmpdir(), `cutos-upload-${Math.random().toString(36).slice(2)}.db`);
  return new SqliteProjectStore(file);
});
