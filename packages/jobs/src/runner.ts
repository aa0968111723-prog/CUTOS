import type { Job, JobContext, JobStore, Worker } from "./types.js";

export interface WorkerRunnerOptions {
  /** Poll interval for claiming queued jobs. */
  pollMs?: number;
  /** How long a running job can go without a heartbeat before it is recovered. */
  staleMs?: number;
  /** How often to sweep for stale jobs. */
  staleSweepMs?: number;
  onError?: (error: unknown, job: Job) => void;
}

/**
 * Claims queued jobs from a {@link JobStore} and runs them through registered
 * {@link Worker}s. Progress, heartbeats, cancellation and retry all flow through
 * the store, so the same behaviour holds whether the store is in-memory or
 * durable SQLite. On start it recovers jobs abandoned by a crashed worker.
 */
export class WorkerRunner {
  private readonly workers = new Map<string, Worker>();
  private readonly store: JobStore;
  private readonly options: Required<Omit<WorkerRunnerOptions, "onError">> & Pick<WorkerRunnerOptions, "onError">;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private draining = false;

  constructor(store: JobStore, workers: Worker[] = [], options: WorkerRunnerOptions = {}) {
    this.store = store;
    for (const worker of workers) this.register(worker);
    this.options = {
      pollMs: options.pollMs ?? 250,
      staleMs: options.staleMs ?? 30_000,
      staleSweepMs: options.staleSweepMs ?? 15_000,
      onError: options.onError,
    };
  }

  register(worker: Worker): void {
    this.workers.set(worker.kind, worker);
  }

  get kinds(): string[] {
    return [...this.workers.keys()];
  }

  /**
   * Whether the poll loop is actually installed.
   *
   * A stopped runner is indistinguishable from an idle one by observation —
   * both simply do nothing — so a health check has no way to tell them apart
   * without asking. Backed by the timer rather than a separate flag, so it
   * cannot drift out of sync with reality.
   */
  get isRunning(): boolean {
    return this.pollTimer !== null;
  }

  start(): void {
    if (this.pollTimer) return;
    // Recover anything a previous (crashed) worker left mid-flight.
    this.store.recoverStale(this.options.staleMs);
    this.pollTimer = setInterval(() => void this.drain(), this.options.pollMs);
    this.sweepTimer = setInterval(
      () => this.store.recoverStale(this.options.staleMs),
      this.options.staleSweepMs,
    );
    // Timers must not keep the process alive on their own.
    this.pollTimer.unref?.();
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.pollTimer = null;
    this.sweepTimer = null;
  }

  /** Process all currently-queued jobs this runner can handle. */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const processed = await this.runOnce();
        if (!processed) break;
      }
    } finally {
      this.draining = false;
    }
  }

  /** Claim and process exactly one job. Returns it, or null if none available. */
  async runOnce(): Promise<Job | null> {
    const job = this.store.claim(this.kinds);
    if (!job) return null;

    const worker = this.workers.get(job.kind);
    if (!worker) {
      this.store.fail(job.id, `no worker registered for kind "${job.kind}"`);
      return this.store.get(job.id) ?? job;
    }

    const controller = new AbortController();
    if (job.cancelRequested) controller.abort();

    const checkCancel = () => {
      if (this.store.get(job.id)?.cancelRequested && !controller.signal.aborted) {
        controller.abort();
      }
    };

    const ctx: JobContext = {
      job,
      signal: controller.signal,
      progress: async (update) => {
        this.store.progress(job.id, update);
        checkCancel();
      },
      heartbeat: async () => {
        this.store.heartbeat(job.id);
        checkCancel();
      },
      isCancelled: () => this.store.get(job.id)?.cancelRequested ?? false,
    };

    try {
      const result = await worker.handle(job.payload, ctx);
      if (ctx.isCancelled()) {
        this.store.fail(job.id, "cancelled");
      } else {
        this.store.complete(job.id, result);
      }
    } catch (error) {
      if (this.options.onError) this.options.onError(error, job);
      this.store.fail(job.id, error instanceof Error ? error.message : String(error));
    }

    return this.store.get(job.id) ?? job;
  }
}
