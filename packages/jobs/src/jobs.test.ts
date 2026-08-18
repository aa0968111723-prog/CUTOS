import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryJobStore } from "./memory-store.js";
import { SqliteJobStore } from "./sqlite-store.js";
import { WorkerRunner } from "./runner.js";
import type { JobStore, Worker } from "./types.js";

function suite(name: string, makeStore: () => JobStore) {
  describe(name, () => {
    let store: JobStore;
    beforeEach(() => {
      store = makeStore();
      store.clear();
    });

    it("enqueues and claims in FIFO order", () => {
      const a = store.enqueue({ kind: "x", payload: { n: 1 } });
      const b = store.enqueue({ kind: "x", payload: { n: 2 } });
      const claimed = store.claim();
      expect(claimed?.id).toBe(a.id);
      expect(claimed?.status).toBe("running");
      expect(claimed?.attempt).toBe(1);
      expect(store.claim()?.id).toBe(b.id);
      expect(store.claim()).toBeUndefined();
    });

    it("tracks progress and completion", () => {
      const job = store.enqueue({ kind: "x", payload: {} });
      store.claim();
      store.progress(job.id, { progress: 0.5, stage: "half" });
      expect(store.get(job.id)?.progress).toBe(0.5);
      expect(store.get(job.id)?.stage).toBe("half");
      store.complete(job.id, { ok: true });
      expect(store.get(job.id)?.status).toBe("succeeded");
      expect(store.get(job.id)?.result).toEqual({ ok: true });
    });

    it("requeues on failure while attempts remain, then fails", () => {
      const job = store.enqueue({ kind: "x", payload: {}, maxAttempts: 2 });
      store.claim();
      store.fail(job.id, "boom");
      expect(store.get(job.id)?.status).toBe("queued");
      store.claim();
      expect(store.get(job.id)?.attempt).toBe(2);
      store.fail(job.id, "boom again");
      expect(store.get(job.id)?.status).toBe("failed");
      expect(store.get(job.id)?.error).toBe("boom again");
    });

    it("cancels queued jobs immediately and running jobs cooperatively", () => {
      const queued = store.enqueue({ kind: "x", payload: {} });
      store.cancel(queued.id);
      expect(store.get(queued.id)?.status).toBe("cancelled");

      const running = store.enqueue({ kind: "x", payload: {} });
      store.claim();
      store.cancel(running.id);
      expect(store.get(running.id)?.status).toBe("running");
      expect(store.get(running.id)?.cancelRequested).toBe(true);
      store.fail(running.id, "cancelled");
      expect(store.get(running.id)?.status).toBe("cancelled");
    });

    it("recovers stale running jobs", () => {
      const job = store.enqueue({ kind: "x", payload: {}, maxAttempts: 2 });
      store.claim();
      const recovered = store.recoverStale(1000, Date.now() + 10_000);
      expect(recovered).toHaveLength(1);
      expect(store.get(job.id)?.status).toBe("queued");
    });
  });
}

suite("MemoryJobStore", () => new MemoryJobStore());
suite("SqliteJobStore(:memory:)", () => new SqliteJobStore(":memory:"));

describe("WorkerRunner", () => {
  it("processes a job to success via a worker", async () => {
    const store = new MemoryJobStore();
    const worker: Worker<{ a: number; b: number }, number> = {
      kind: "add",
      async handle(payload, ctx) {
        await ctx.progress({ progress: 0.5, stage: "adding" });
        return payload.a + payload.b;
      },
    };
    const runner = new WorkerRunner(store, [worker]);
    const job = store.enqueue({ kind: "add", payload: { a: 2, b: 3 } });
    const done = await runner.runOnce();
    expect(done?.status).toBe("succeeded");
    expect(store.get(job.id)?.result).toBe(5);
  });

  it("retries then fails a throwing worker", async () => {
    const store = new MemoryJobStore();
    let calls = 0;
    const worker: Worker = {
      kind: "flaky",
      async handle() {
        calls += 1;
        throw new Error("nope");
      },
    };
    const runner = new WorkerRunner(store, [worker]);
    const job = store.enqueue({ kind: "flaky", payload: {}, maxAttempts: 2 });
    await runner.runOnce();
    expect(store.get(job.id)?.status).toBe("queued");
    await runner.runOnce();
    expect(store.get(job.id)?.status).toBe("failed");
    expect(calls).toBe(2);
  });

  it("stops a running worker when cancellation is requested", async () => {
    const store = new MemoryJobStore();
    const worker: Worker = {
      kind: "loop",
      async handle(_payload, ctx) {
        for (let i = 0; i < 100; i += 1) {
          await ctx.heartbeat();
          if (ctx.isCancelled()) throw new Error("aborted");
          if (i === 0) store.cancel(ctx.job.id);
        }
        return "done";
      },
    };
    const runner = new WorkerRunner(store, [worker]);
    const job = store.enqueue({ kind: "loop", payload: {} });
    await runner.runOnce();
    expect(store.get(job.id)?.status).toBe("cancelled");
  });
});

describe("SqliteJobStore durability", () => {
  let dir = "";
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("survives a store reopen (simulated restart)", async () => {
    dir = await mkdtemp(join(tmpdir(), "cutos-jobs-"));
    const file = join(dir, "jobs.db");

    const first = new SqliteJobStore(file);
    const job = first.enqueue({
      kind: "export",
      payload: { projectId: "p1" },
      projectId: "p1",
      maxAttempts: 2,
    });
    first.claim();
    first.progress(job.id, { progress: 0.42, stage: "rendering" });
    first.close();

    // Reopen as if the server restarted.
    const second = new SqliteJobStore(file);
    const recovered = second.get(job.id);
    expect(recovered?.progress).toBe(0.42);
    expect(recovered?.stage).toBe("rendering");
    // A previously-running job is recoverable back to queued.
    const stale = second.recoverStale(0);
    expect(stale.map((j) => j.id)).toContain(job.id);
    expect(second.get(job.id)?.status).toBe("queued");
    second.close();
  });
});
