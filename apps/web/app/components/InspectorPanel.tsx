"use client";

import type { ProjectDTO } from "../lib/types.js";
import { t } from "../i18n/index.js";

export function InspectorPanel({ project }: { project: ProjectDTO }) {
  return (
    <div className="card">
      <h2>{t("inspector.title")}</h2>
      <dl className="inspector">
        <div><dt>{t("inspector.provider")}</dt><dd>{project.provider}</dd></div>
        <div><dt>{t("inspector.resolution")}</dt><dd>{project.source.width ?? "?"}×{project.source.height ?? "?"}</dd></div>
        <div><dt>{t("inspector.audio")}</dt><dd>{project.source.hasAudio ? t("common.yes") : t("common.no")}</dd></div>
        <div><dt>{t("inspector.version")}</dt><dd>{project.version}</dd></div>
        <div><dt>{t("inspector.timelineRev")}</dt><dd>{project.timelineRevision}</dd></div>
        <div><dt>{t("inspector.pauses")}</dt><dd>{project.analysis?.silences.length ?? "—"}</dd></div>
        <div><dt>{t("inspector.waveform")}</dt><dd>{project.analysis?.hasWaveform ? t("common.yes") : "—"}</dd></div>
        <div><dt>{t("inspector.sentences")}</dt><dd>{project.analysis?.sentenceCount ?? "—"}</dd></div>
      </dl>
    </div>
  );
}
