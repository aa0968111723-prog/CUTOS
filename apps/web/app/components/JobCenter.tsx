"use client";

import type { JobDTO } from "../lib/api.js";
import { t, type MessageKey } from "../i18n/index.js";

/** Floating indicator for the active background job (analysis/export). */
export function JobCenter({ job }: { job: JobDTO | null }) {
  if (!job || (job.status !== "running" && job.status !== "queued")) return null;
  const kindLabel = job.kind === "export" ? t("export.title") : t("import.analyzing");
  const statusKey = `job.status.${job.status}` as MessageKey;
  return (
    <div className="job-center" role="status" aria-live="polite">
      <span className="spinner" />
      <span>
        {kindLabel} · {t(statusKey)} · {Math.round(job.progress * 100)}%
      </span>
    </div>
  );
}
