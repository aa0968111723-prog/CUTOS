export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/**
 * A unit of durable background work. Jobs are persisted so their metadata
 * survives a server restart and a worker crash: analysis, proxy generation,
 * transcription and export never live inside an HTTP request lifecycle.
 */
export interface Job<TPayload = unknown, TResult = unknown> {
  id: string;
  kind: string;
  projectId: string | null;
  status: JobStatus;
  /** 0..1 fractional completion. */
  progress: number;
  /** Human-readable current stage, e.g. "probing", "detecting silence". */
  stage: string | null;
  attempt: number;
  maxAttempts: number;
  payload: TPayload;
  result: TResult | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  heartbeatAt: number | null;
  /** Set when a running job has been asked to cancel. */
  cancelRequested: boolean;
}

export interface EnqueueInput<TPayload = unknown> {
  kind: string;
  payload: TPayload;
  projectId?: string | null;
  maxAttempts?: number;
}

export interface JobFilter {
  status?: JobStatus;
  kind?: string;
  projectId?: string | null;
}

export interface ProgressUpdate {
  progress?: number;
  stage?: string;
}

/**
 * Handle passed to a worker while it processes a job. Workers report progress
 * and heartbeats through it and observe cooperative cancellation.
 */
export interface JobContext<TPayload = unknown> {
  readonly job: Job<TPayload>;
  readonly signal: AbortSignal;
  progress(update: ProgressUpdate): Promise<void>;
  heartbeat(): Promise<void>;
  isCancelled(): boolean;
}

/** A typed processor for one job kind. */
export interface Worker<TPayload = unknown, TResult = unknown> {
  readonly kind: string;
  handle(payload: TPayload, ctx: JobContext<TPayload>): Promise<TResult>;
}

export interface JobStore {
  enqueue<TPayload>(input: EnqueueInput<TPayload>): Job<TPayload>;
  get(id: string): Job | undefined;
  list(filter?: JobFilter): Job[];
  /** Atomically claim the oldest queued job (optionally filtered by kind). */
  claim(kinds?: string[]): Job | undefined;
  heartbeat(id: string): void;
  progress(id: string, update: ProgressUpdate): void;
  complete(id: string, result: unknown): Job;
  fail(id: string, error: string): Job;
  /** Force a failed/cancelled job back to queued. */
  retry(id: string): Job;
  /** Request cancellation. Queued jobs are cancelled immediately; running jobs are flagged. */
  cancel(id: string): Job;
  /**
   * Recover jobs that were left running by a crashed worker (heartbeat older
   * than `staleMs`): requeue when attempts remain, otherwise fail.
   */
  recoverStale(staleMs: number, now?: number): Job[];
  clear(): void;
}

export class JobNotFoundError extends Error {
  constructor(id: string) {
    super(`Job ${id} not found`);
    this.name = "JobNotFoundError";
  }
}
