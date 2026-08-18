import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "@cutos/media";
import { createSqliteProjectStore } from "@cutos/project-store";
import type * as EditorService from "./editor-service.js";

/**
 * End-to-end service test exercising the real production wiring (durable SQLite
 * store, job worker, storage, agent runtime, FFmpeg) through the editor
 * service: import → analyze → plan → reject one op → apply → undo → redo →
 * export → "restart" (reopen the DB) → project still exists.
 */
describe("editor service E2E (ffmpeg + durable store)", () => {
  let dir = "";
  let available = false;
  // Loaded dynamically after env is configured.
  let service: typeof EditorService;
  let dbFile = "";

  beforeAll(async () => {
    try {
      await run("ffmpeg", ["-version"]);
      available = true;
    } catch {
      available = false;
    }
    dir = await mkdtemp(join(tmpdir(), "cutos-e2e-"));
    dbFile = join(dir, "cutos.db");
    process.env.CUTOS_DATA_DIR = dir;
    process.env.CUTOS_STORE = "sqlite";
    service = await import("./editor-service.js");
  }, 30_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function waitForJob(jobId: string): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      const job = service.getJob(jobId);
      if (job.status === "succeeded") return;
      if (job.status === "failed" || job.status === "cancelled") {
        throw new Error(`job ${jobId} ${job.status}: ${job.error}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("job did not finish in time");
  }

  it("runs the full editing loop and persists across a restart", async () => {
    if (!available) return;

    // Import
    const projectId = await service.importSample();
    expect(service.getProject(projectId).source.durationMs).toBeGreaterThan(11_000);

    // Analyze (durable job → worker)
    await waitForJob(service.enqueueAnalyze(projectId));
    const analyzed = service.getProject(projectId);
    expect(analyzed.analysis?.silences.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(analyzed.analysis?.hasWaveform).toBe(true);

    // Plan
    const planned = await service.plan(projectId, "remove pauses longer than 1 second");
    expect(planned.dto.pendingPlan?.operations.length).toBeGreaterThanOrEqual(3);
    const opCount = planned.dto.pendingPlan!.operations.length;

    // Reject one operation (operation-level review)
    const afterReject = service.rejectOperation(projectId, 0);
    expect(afterReject.pendingPlan?.operations.length).toBe(opCount - 1);

    // Apply
    const applied = service.applyPending(projectId);
    expect(applied.timeline.durationMs).toBeLessThan(applied.source.durationMs);
    expect(applied.pendingPlan).toBeUndefined();
    const editedDuration = applied.timeline.durationMs;

    // Undo / redo
    const undone = service.undo(projectId);
    expect(undone.timeline.durationMs).toBe(undone.source.durationMs);
    const redone = service.redo(projectId);
    expect(redone.timeline.durationMs).toBe(editedDuration);

    // Export (durable job → worker → stored asset)
    await waitForJob(service.enqueueExport(projectId));
    const exported = service.getProject(projectId);
    expect(exported.hasExport).toBe(true);

    // "Restart": reopen the same SQLite database with a fresh store handle.
    const reopened = createSqliteProjectStore(dbFile);
    const recovered = reopened.getProject(projectId);
    expect(recovered).toBeDefined();
    const state = reopened.loadTimeline(projectId);
    expect(state?.revision).toBeGreaterThan(0);
    expect(reopened.listRuns(projectId).length).toBeGreaterThan(0);
    reopened.close();
  }, 120_000);
});
