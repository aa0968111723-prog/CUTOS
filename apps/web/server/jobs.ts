import { randomUUID } from "node:crypto";

export type JobStatus = "running" | "succeeded" | "failed";

export interface JobRecord {
  id: string;
  kind: string;
  status: JobStatus;
  error?: string;
  createdAtMs: number;
  updatedAtMs: number;
}

/**
 * Minimal in-process job runner. Long-running media analysis and rendering run
 * here rather than blocking the request handler, mirroring the worker/queue
 * boundary described in the architecture. The abstraction can later be backed
 * by a real queue without changing call sites.
 */
class JobQueue {
  private jobs = new Map<string, JobRecord>();

  start(kind: string, task: () => Promise<void>): JobRecord {
    const now = Date.now();
    const job: JobRecord = {
      id: randomUUID(),
      kind,
      status: "running",
      createdAtMs: now,
      updatedAtMs: now,
    };
    this.jobs.set(job.id, job);

    void task()
      .then(() => {
        job.status = "succeeded";
        job.updatedAtMs = Date.now();
      })
      .catch((error: unknown) => {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        job.updatedAtMs = Date.now();
      });

    return job;
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }
}

const globalRef = globalThis as unknown as { __cutosJobQueue?: JobQueue };
export const jobs: JobQueue = (globalRef.__cutosJobQueue ??= new JobQueue());
