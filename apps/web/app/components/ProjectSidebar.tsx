"use client";

import type { Editor } from "../hooks/useEditor.js";
import { formatSeconds } from "../lib/format.js";

export function ProjectSidebar({ editor }: { editor: Editor }) {
  return (
    <div className="card">
      <h2>Projects</h2>
      <div className="row" style={{ marginBottom: 10 }}>
        <button className="btn btn-sm" onClick={() => editor.closeProject()}>
          + New / Import
        </button>
      </div>
      {editor.projects.map((p) => (
        <div key={p.id} className={`history-item ${editor.project?.id === p.id ? "active" : ""}`}>
          <button className="linklike" onClick={() => void editor.openProject(p.id)}>
            {p.name}
            <span className="muted"> · {formatSeconds(p.durationMs)}</span>
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => void editor.removeProject(p.id)}>
            ✕
          </button>
        </div>
      ))}
      {editor.projects.length === 0 && <p className="muted">No projects yet.</p>}
    </div>
  );
}
