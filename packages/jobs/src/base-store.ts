import { randomUUID } from "node:crypto";
import {
  JobNotFoundError,
  type EnqueueInput,
  type Job,
  type JobFilter,
  type JobStore,
  type ProgressUpdate,
} from "./types.js";

/**
 * Shared job state-machine logic. Concrete stores implement only the storage
 * primitives (read/save/insert/all); all lifecycle transitions live here so
 * memory and SQLite backends behave identically.
 */
export abstract class BaseJobStore implements JobStore {
  protected now(): number {
    return Date.now();
  }

  protected abstract insert(job: Job): void;
  protected abstract read(id: string): Job | undefined;
  protected abstract save(job: Job): void;
  protected abstract all(): Job[];
  abstract clear(): void;

  enqueue<TPayload>(input: EnqueueInput<TPayload>): Job<TPayload> {
    const now = this.now();
    const job: Job<TPayload> = {
      id: randomUUID(),
      kind: input.kind,
      projectId: input.projectId ?? null,
      status: "queued",
      progress: 0,
      stage: null,
      attempt: 0,
      maxAttempts: Math.max(1, input.maxAttempts ?? 1),
      payload: input.payload,
      result: null,
      error: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      heartbeatAt: null,
      cancelRequested: false,
    };
    this.insert(job as Job);
    return job;
  }

  get(id: string): Job | undefined {
    return this.read(id);
  }

  list(filter: JobFilter = {}): Job[] {
    return this.all()
      .filter((job) => {
        if (filter.status && job.status !== filter.status) return false;
        if (filter.kind && job.kind !== filter.kind) return false;
        if (filter.projectId !== undefined && job.projectId !== filter.projectId) return false;
        return true;
      })
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  claim(kinds?: string[]): Job | undefined {
    const next = this.all()
      .filter((job) => job.status === "queued" && (!kinds || kinds.includes(job.kind)))
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!next) return undefined;

    const now = this.now();
    next.status = "running";
    next.attempt += 1;
    next.startedAt = next.startedAt ?? now;
    next.heartbeatAt = now;
    next.cancelRequested = false;
    this.save(next);
    return next;
  }

  private require(id: string): Job {
    const job = this.read(id);
    if (!job) throw new JobNotFoundError(id);
    return job;
  }

  heartbeat(id: string): void {
    const job = this.read(id);
    if (!job || job.status !== "running") return;
    job.heartbeatAt = this.now();
    this.save(job);
  }

  progress(id: string, update: ProgressUpdate): void {
    const job = this.read(id);
    if (!job || job.status !== "running") return;
    if (update.progress !== undefined) {
      job.progress = Math.max(0, Math.min(1, update.progress));
    }
    if (update.stage !== undefined) {
      job.stage = update.stage;
    }
    job.heartbeatAt = this.now();
    this.save(job);
  }

  complete(id: string, result: unknown): Job {
    const job = this.require(id);
    job.status = "succeeded";
    job.result = result;
    job.progress = 1;
    job.error = null;
    job.finishedAt = this.now();
    this.save(job);
    return job;
  }

  fail(id: string, error: string): Job {
    const job = this.require(id);
    job.error = error;
    if (!job.cancelRequested && job.attempt < job.maxAttempts) {
      // Attempts remain: requeue for another try.
      job.status = "queued";
      job.stage = null;
      job.heartbeatAt = null;
      job.startedAt = null;
    } else {
      job.status = job.cancelRequested ? "cancelled" : "failed";
      job.finishedAt = this.now();
    }
    this.save(job);
    return job;
  }

  retry(id: string): Job {
    const job = this.require(id);
    if (job.status === "running" || job.status === "queued") return job;
    job.status = "queued";
    job.error = null;
    job.stage = null;
    job.progress = 0;
    job.finishedAt = null;
    job.startedAt = null;
    job.heartbeatAt = null;
    job.cancelRequested = false;
    this.save(job);
    return job;
  }

  cancel(id: string): Job {
    const job = this.require(id);
    if (job.status === "queued") {
      job.status = "cancelled";
      job.finishedAt = this.now();
      job.cancelRequested = true;
    } else if (job.status === "running") {
      // Cooperative: flag it; the worker observes the signal and stops.
      job.cancelRequested = true;
    }
    this.save(job);
    return job;
  }

  recoverStale(staleMs: number, now: number = this.now()): Job[] {
    const recovered: Job[] = [];
    for (const job of this.all()) {
      if (job.status !== "running") continue;
      const last = job.heartbeatAt ?? job.startedAt ?? job.createdAt;
      if (now - last < staleMs) continue;

      job.error = "worker stopped responding (stale heartbeat)";
      if (job.attempt < job.maxAttempts) {
        job.status = "queued";
        job.stage = null;
        job.startedAt = null;
        job.heartbeatAt = null;
      } else {
        job.status = "failed";
        job.finishedAt = now;
      }
      this.save(job);
      recovered.push(job);
    }
    return recovered;
  }
}
