"use client";

import { useState } from "react";
import type { Editor } from "../hooks/useEditor.js";
import type { ProjectDTO } from "../lib/types.js";
import { formatSeconds } from "../lib/format.js";
import { t } from "../i18n/index.js";

export function ExportPanel({ editor, project }: { editor: Editor; project: ProjectDTO }) {
  const [version, setVersion] = useState(0);
  const exporting = editor.job?.kind === "export";

  const onExport = async () => {
    await editor.runExport();
    setVersion((v) => v + 1);
  };

  return (
    <div className="card">
      <h2>{t("export.title")}</h2>
      <p className="muted" style={{ marginTop: 0 }}>{t("export.hint")}</p>
      <button className="btn btn-primary" onClick={() => void onExport()} disabled={editor.busy !== null}>
        {exporting ? <span className="spinner" /> : t("export.start")}
      </button>
      {exporting && editor.job && (
        <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          {t("export.rendering")} · {Math.round(editor.job.progress * 100)}%
        </p>
      )}
      {project.hasExport && (
        <div style={{ marginTop: 14 }}>
          <video key={version} className="player" src={`/api/projects/${project.id}/output?v=${version}`} controls />
          <div className="row" style={{ marginTop: 10 }}>
            {project.exportDurationMs != null && (
              <span className="badge">{t("export.rendered", { seconds: formatSeconds(project.exportDurationMs) })}</span>
            )}
            <a className="btn" href={`/api/projects/${project.id}/output?v=${version}`} download="cutos-export.mp4">
              {t("export.download")}
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
