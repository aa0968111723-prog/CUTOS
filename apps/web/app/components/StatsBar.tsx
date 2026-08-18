"use client";

import type { ProjectDTO } from "../lib/types.js";
import { formatSeconds } from "../lib/format.js";
import { t } from "../i18n/index.js";

export function StatsBar({ project }: { project: ProjectDTO }) {
  const removedMs = Math.max(0, project.source.durationMs - project.timeline.durationMs);
  return (
    <div className="stat statbar">
      <div>
        <b>{formatSeconds(project.source.durationMs)}</b>
        <span>{t("stats.source")}</span>
      </div>
      <div>
        <b>{formatSeconds(project.timeline.durationMs)}</b>
        <span>{t("stats.edited")}</span>
      </div>
      <div>
        <b>{formatSeconds(removedMs)}</b>
        <span>{t("stats.removed")}</span>
      </div>
      <div>
        <b>{project.timeline.clips.length}</b>
        <span>{t("stats.clips")}</span>
      </div>
      <div>
        <b>{project.timelineRevision}</b>
        <span>{t("stats.timeline")}</span>
      </div>
    </div>
  );
}
