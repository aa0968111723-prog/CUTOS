"use client";

import { useState } from "react";
import type { Editor } from "../hooks/useEditor.js";
import type { ProjectDTO } from "../lib/types.js";
import { formatSeconds } from "../lib/format.js";

export function ExportPanel({ editor, project }: { editor: Editor; project: ProjectDTO }) {
  const [version, setVersion] = useState(0);
  const exporting = editor.busy === "Rendering export…";

  const onExport = async () => {
    await editor.runExport();
    setVersion((v) => v + 1);
  };

  return (
    <div className="card">
      <h2>Export</h2>
      <p className="muted" style={{ marginTop: 0 }}>Deterministic FFmpeg render of the current timeline.</p>
      <button className="btn btn-primary" onClick={() => void onExport()} disabled={editor.busy !== null}>
        {exporting ? <span className="spinner" /> : "Export video"}
      </button>
      {exporting && editor.job && (
        <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          {editor.job.stage ?? "working"} · {Math.round(editor.job.progress * 100)}%
        </p>
      )}
      {project.hasExport && (
        <div style={{ marginTop: 14 }}>
          <video key={version} className="player" src={`/api/projects/${project.id}/output?v=${version}`} controls />
          <div className="row" style={{ marginTop: 10 }}>
            {project.exportDurationMs != null && (
              <span className="badge">rendered {formatSeconds(project.exportDurationMs)}</span>
            )}
            <a className="btn" href={`/api/projects/${project.id}/output?v=${version}`} download="cutos-export.mp4">
              Download
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
