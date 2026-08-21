import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryRepositories } from "./memory.js";
import { createSqliteRepositories } from "./sqlite.js";
import type { Repositories } from "./facade.js";

const CLEANUP: Array<() => void> = [];

afterEach(() => {
  while (CLEANUP.length) CLEANUP.pop()!();
});

function sqliteRepos(): Repositories {
  const dir = mkdtempSync(join(tmpdir(), "cutos-aios-store-"));
  const repos = createSqliteRepositories(join(dir, "store.db"));
  CLEANUP.push(() => {
    repos.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return repos;
}

const BACKENDS: Array<[string, () => Repositories]> = [
  ["memory", () => createMemoryRepositories()],
  ["sqlite", sqliteRepos],
];

const claim = (overrides: Partial<Parameters<Repositories["idempotency"]["claim"]>[0]> = {}) => ({
  projectId: "p1",
  capability: "apply_edit_plan",
  idempotencyKey: "cutos.v2:run-1:step-1:apply_edit_plan:p1:abc",
  requestId: "req-1",
  argsFingerprint: "fp-1",
  aiosRunId: "run-1",
  aiosStepId: "step-1",
  leaseMs: 60_000,
  now: 1_000,
  ...overrides,
});

describe.each(BACKENDS)("idempotency repository (%s)", (_name, make) => {
  it("acquires a fresh key and reports the claim as owned", () => {
    const repos = make();
    const result = repos.idempotency.claim(claim());
    expect(result.state).toBe("acquired");
    expect(result.record.status).toBe("in_progress");
    expect(result.record.aiosRunId).toBe("run-1");
  });

  it("blocks a second concurrent attempt while the lease is alive", () => {
    const repos = make();
    repos.idempotency.claim(claim());
    const second = repos.idempotency.claim(claim({ requestId: "req-2", now: 2_000 }));
    expect(second.state).toBe("in_progress");
  });

  it("replays the stored result instead of mutating twice", () => {
    const repos = make();
    const first = repos.idempotency.claim(claim());
    repos.idempotency.complete(first.record.id, { applied: true, planId: "plan-1" }, 7, 3_000);
    const retry = repos.idempotency.claim(claim({ requestId: "req-2", now: 4_000 }));
    expect(retry.state).toBe("completed");
    expect(retry.record.result).toEqual({ applied: true, planId: "plan-1" });
    expect(retry.record.timelineRevision).toBe(7);
  });

  it("reclaims a lease abandoned by a crashed process, and says so", () => {
    const repos = make();
    repos.idempotency.claim(claim());
    const afterCrash = repos.idempotency.claim(
      claim({ requestId: "req-after-restart", now: 1_000 + 60_001 }),
    );
    // NOT "acquired". The distinction is the whole safety property: a caller
    // told "acquired" re-executes, and re-executing an apply/export that a
    // dead attempt may already have performed is the double-edit this ledger
    // exists to prevent. "reclaimed" says: the key is yours, reconcile first.
    expect(afterCrash.state).toBe("reclaimed");
    expect(afterCrash.record.requestId).toBe("req-after-restart");
  });

  it("never reports a fresh claim as reclaimed", () => {
    const repos = make();
    expect(repos.idempotency.claim(claim()).state).toBe("acquired");
  });

  it("keeps reporting reclaimed until an outcome is recorded", () => {
    const repos = make();
    repos.idempotency.claim(claim());
    const first = repos.idempotency.claim(claim({ requestId: "r2", now: 1_000 + 60_001 }));
    expect(first.state).toBe("reclaimed");
    // A second crash in the recovery attempt must not downgrade to "acquired".
    const second = repos.idempotency.claim(claim({ requestId: "r3", now: 1_000 + 120_002 }));
    expect(second.state).toBe("reclaimed");
    repos.idempotency.complete(second.record.id, { applied: true }, 2, 200_000);
    expect(repos.idempotency.claim(claim({ requestId: "r4", now: 300_000 })).state).toBe("completed");
  });

  it("refuses to reuse a key for different arguments", () => {
    const repos = make();
    const first = repos.idempotency.claim(claim());
    repos.idempotency.complete(first.record.id, { applied: true }, 1, 2_000);
    const conflicting = repos.idempotency.claim(
      claim({ argsFingerprint: "fp-DIFFERENT", requestId: "req-3", now: 3_000 }),
    );
    expect(conflicting.state).not.toBe("acquired");
    expect(conflicting.state).not.toBe("completed");
  });

  it("records a terminal failure so the caller does not spin forever", () => {
    const repos = make();
    const first = repos.idempotency.claim(claim());
    repos.idempotency.fail(first.record.id, "UNSUPPORTED_OPERATION", 2_000);
    const retry = repos.idempotency.claim(claim({ requestId: "req-2", now: 3_000 }));
    expect(retry.state).toBe("failed");
    expect(retry.record.errorCode).toBe("UNSUPPORTED_OPERATION");
  });

  it("lets an explicit release re-open the claim immediately", () => {
    const repos = make();
    const first = repos.idempotency.claim(claim());
    repos.idempotency.release(first.record.id, 1_500);
    const retry = repos.idempotency.claim(claim({ requestId: "req-2", now: 1_600 }));
    expect(retry.state).toBe("acquired");
  });

  it("reads a record back by its natural key", () => {
    const repos = make();
    const first = repos.idempotency.claim(claim());
    const found = repos.idempotency.get("p1", "apply_edit_plan", first.record.idempotencyKey);
    expect(found?.id).toBe(first.record.id);
  });
});

describe.each(BACKENDS)("activity repository (%s)", (_name, make) => {
  const event = (id: string) => ({
    id,
    projectId: "p1",
    at: 1_000,
    kind: "analyze",
    status: "started",
    messageKey: "activity.analyze.started",
    aiosRunId: "run-1",
    aiosStepId: null,
    cutosAgentRunId: null,
    cutosJobId: "job-1",
    metadata: { sections: 4 },
  });

  it("assigns a monotonic per-project sequence", () => {
    const repos = make();
    expect(repos.activity.append(event("a")).sequence).toBe(1);
    expect(repos.activity.append(event("b")).sequence).toBe(2);
    expect(repos.activity.append({ ...event("c"), projectId: "p2" }).sequence).toBe(1);
  });

  it("streams events after a cursor", () => {
    const repos = make();
    repos.activity.append(event("a"));
    repos.activity.append(event("b"));
    repos.activity.append(event("c"));
    const tail = repos.activity.list("p1", { afterSequence: 1 });
    expect(tail.map((e) => e.id)).toEqual(["b", "c"]);
  });

  it("round-trips scalar metadata", () => {
    const repos = make();
    repos.activity.append(event("a"));
    expect(repos.activity.list("p1")[0]!.metadata).toEqual({ sections: 4 });
  });
});

describe.each(BACKENDS)("aios run repository (%s)", (_name, make) => {
  const record = () => ({
    id: "handle-1",
    projectId: "p1",
    aiosRunId: null,
    status: "queued" as const,
    capability: "video.edit.plan",
    goal: "剪成八分鐘精華",
    qualityProfile: "balanced",
    requestId: "req-1",
    idempotencyKey: "key-1",
    errorCode: null,
    createdAt: 1_000,
    updatedAt: 1_000,
  });

  it("persists and updates a submitted run handle", () => {
    const repos = make();
    repos.aiosRuns.save(record());
    repos.aiosRuns.save({
      ...record(),
      aiosRunId: "aios-run-9",
      status: "running",
      state: { steps: [] },
      updatedAt: 2_000,
    });
    const found = repos.aiosRuns.get("handle-1");
    expect(found?.aiosRunId).toBe("aios-run-9");
    expect(found?.status).toBe("running");
    expect(found?.state).toEqual({ steps: [] });
  });

  it("finds a handle by idempotency key so a resubmit does not duplicate", () => {
    const repos = make();
    repos.aiosRuns.save(record());
    expect(repos.aiosRuns.getByIdempotencyKey("key-1")?.id).toBe("handle-1");
    expect(repos.aiosRuns.getByIdempotencyKey("missing")).toBeUndefined();
  });
});

describe("sqlite durability", () => {
  it("survives a reopen (restart recovery)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cutos-aios-restart-"));
    const file = join(dir, "store.db");
    const first = createSqliteRepositories(file);
    const acquired = first.idempotency.claim(claim());
    first.idempotency.complete(acquired.record.id, { applied: true }, 4, 2_000);
    first.activity.append({
      id: "a",
      projectId: "p1",
      at: 1,
      kind: "apply",
      status: "completed",
      messageKey: "activity.apply.completed",
      aiosRunId: null,
      aiosStepId: null,
      cutosAgentRunId: null,
      cutosJobId: null,
      metadata: {},
    });
    first.close();

    const second = createSqliteRepositories(file);
    try {
      const replay = second.idempotency.claim(claim({ requestId: "req-after-restart", now: 9_000 }));
      expect(replay.state).toBe("completed");
      expect(replay.record.result).toEqual({ applied: true });
      expect(second.activity.list("p1")).toHaveLength(1);
    } finally {
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
