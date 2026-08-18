import { BaseJobStore } from "./base-store.js";
import type { Job } from "./types.js";

/** In-memory job store. Ideal for tests and single-process dev without a DB. */
export class MemoryJobStore extends BaseJobStore {
  private jobs = new Map<string, Job>();

  protected insert(job: Job): void {
    this.jobs.set(job.id, clone(job));
  }

  protected read(id: string): Job | undefined {
    const job = this.jobs.get(id);
    return job ? clone(job) : undefined;
  }

  protected save(job: Job): void {
    this.jobs.set(job.id, clone(job));
  }

  protected all(): Job[] {
    return [...this.jobs.values()].map(clone);
  }

  clear(): void {
    this.jobs.clear();
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
