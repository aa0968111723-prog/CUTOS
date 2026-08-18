"use client";

import type { JobDTO } from "../lib/api.js";

/** Floating indicator for the active background job (analysis/export). */
export function JobCenter({ job }: { job: JobDTO | null }) {
  if (!job || (job.status !== "running" && job.status !== "queued")) return null;
  return (
    <div className="job-center">
      <span className="spinner" />
      <span>
        {job.kind}: {job.stage ?? job.status} · {Math.round(job.progress * 100)}%
      </span>
    </div>
  );
}
