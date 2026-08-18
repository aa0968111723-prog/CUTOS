import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { EDIT_DSL_VERSION, type EditPlan } from "@cutos/edit-dsl";
import { applyPlan, createTimeline, type SourceMedia } from "@cutos/timeline";
import { ANALYSIS_VERSION, type MediaAsset, type VideoAnalysis } from "@cutos/media";
import { ProjectStore } from "./facade.js";
import { createMemoryProjectStore } from "./memory.js";
import { createSqliteProjectStore, SqliteProjectStore } from "./sqlite.js";
import { ConcurrencyError, type PersistedTimelineState } from "./types.js";

const source: SourceMedia = {
  id: "src1",
  uri: "storage://sources/src1/original.mp4",
  durationMs: 12_000,
  hasAudio: true,
};

function samplePlan(): EditPlan {
  return {
    version: EDIT_DSL_VERSION,
    id: "plan_1",
    createdAtMs: 1,
    instruction: "remove pauses",
    summary: "Remove 1 pause",
    provider: "local-heuristic",
    operations: [{ type: "removeRange", startMs: 2000, endMs: 4000 }],
  };
}

function suite(name: string, makeStore: () => ProjectStore) {
  describe(name, () => {
    let store: ProjectStore;
    beforeEach(() => {
      store = makeStore();
    });

    it("creates a project with an initial timeline", () => {
      const p = store.createProject({ name: "P", source, width: 640, height: 360 });
      expect(p.version).toBe(0);
      expect(p.timelineRevision).toBe(0);
      const state = store.loadTimeline(p.id);
      expect(state?.current.track.clips).toHaveLength(1);
    });

    it("enforces optimistic concurrency on update", () => {
      const p = store.createProject({ name: "P", source, width: null, height: null });
      const updated = store.updateProject(p.id, { name: "renamed" }, 0);
      expect(updated.version).toBe(1);
      expect(updated.name).toBe("renamed");
      expect(() => store.updateProject(p.id, { name: "again" }, 0)).toThrow(ConcurrencyError);
    });

    it("persists timeline edits and bumps the revision", () => {
      const p = store.createProject({ name: "P", source, width: null, height: null });
      const edited = applyPlan(createTimeline(source), samplePlan());
      const state: PersistedTimelineState = {
        revision: 1,
        current: edited,
        past: [{ plan: samplePlan(), timeline: edited }],
        future: [],
      };
      const rec = store.saveTimeline(p.id, state);
      expect(rec.timelineRevision).toBe(1);
      const loaded = store.loadTimeline(p.id);
      expect(loaded?.revision).toBe(1);
      expect(loaded?.past).toHaveLength(1);
      expect(loaded?.current.track.clips.length).toBeGreaterThan(1);
    });

    it("stores and clears the pending plan", () => {
      const p = store.createProject({ name: "P", source, width: null, height: null });
      store.savePendingPlan(p.id, samplePlan());
      expect(store.loadPendingPlan(p.id)?.id).toBe("plan_1");
      store.savePendingPlan(p.id, null);
      expect(store.loadPendingPlan(p.id)).toBeNull();
    });

    it("appends an operation log", () => {
      const p = store.createProject({ name: "P", source, width: null, height: null });
      store.appendOperation({
        projectId: p.id,
        at: Date.now(),
        revision: 1,
        kind: "apply",
        planId: "plan_1",
        summary: "Remove 1 pause",
        operationCount: 1,
      });
      const ops = store.operations(p.id);
      expect(ops).toHaveLength(1);
      expect(ops[0]?.kind).toBe("apply");
    });

    it("saves and loads a versioned analysis", () => {
      const p = store.createProject({ name: "P", source, width: null, height: null });
      const analysis: VideoAnalysis = {
        analysisVersion: ANALYSIS_VERSION,
        mediaChecksum: "abc",
        updatedAt: Date.now(),
        silences: [{ startMs: 2000, endMs: 4000 }],
      };
      store.saveAnalysis(p.id, analysis);
      expect(store.loadAnalysis(p.id)?.silences).toHaveLength(1);
    });

    it("tracks media assets by kind", () => {
      const p = store.createProject({ name: "P", source, width: null, height: null });
      const asset: MediaAsset = {
        id: "a1",
        projectId: p.id,
        kind: "original",
        mimeType: "video/mp4",
        storageKey: `sources/${p.id}/original.mp4`,
        checksum: "deadbeef",
        sizeBytes: 123,
        durationMs: 12_000,
        width: 640,
        height: 360,
        codec: "h264",
        createdAt: Date.now(),
      };
      store.addAsset(asset);
      expect(store.getAssetByKind(p.id, "original")?.id).toBe("a1");
      expect(store.listAssets(p.id)).toHaveLength(1);
    });

    it("cascades delete", () => {
      const p = store.createProject({ name: "P", source, width: null, height: null });
      store.savePendingPlan(p.id, samplePlan());
      store.deleteProject(p.id);
      expect(store.getProject(p.id)).toBeUndefined();
      expect(store.loadTimeline(p.id)).toBeUndefined();
      expect(store.loadPendingPlan(p.id)).toBeNull();
    });
  });
}

suite("MemoryProjectStore", () => createMemoryProjectStore());
suite("SqliteProjectStore(:memory:)", () => createSqliteProjectStore(":memory:"));

describe("SqliteProjectStore durability (restart recovery)", () => {
  let dir = "";
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("recovers project + timeline after reopening the database", async () => {
    dir = await mkdtemp(join(tmpdir(), "cutos-store-"));
    const file = join(dir, "cutos.db");

    const first = new SqliteProjectStore(file);
    const p = first.createProject({ name: "Persisted", source, width: 640, height: 360 });
    const edited = applyPlan(createTimeline(source), samplePlan());
    first.saveTimeline(p.id, { revision: 1, current: edited, past: [{ plan: samplePlan(), timeline: edited }], future: [] });
    first.savePendingPlan(p.id, samplePlan());
    first.close();

    // Simulate server restart.
    const second = new SqliteProjectStore(file);
    const recovered = second.getProject(p.id);
    expect(recovered?.name).toBe("Persisted");
    expect(recovered?.timelineRevision).toBe(1);
    const state = second.loadTimeline(p.id);
    expect(state?.revision).toBe(1);
    expect(state?.current.track.clips.length).toBeGreaterThan(1);
    expect(second.loadPendingPlan(p.id)?.id).toBe("plan_1");
    second.close();
  });
});
