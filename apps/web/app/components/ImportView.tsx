"use client";

import { useRef } from "react";
import type { ChangeEvent } from "react";
import type { Editor } from "../hooks/useEditor.js";
import { formatSeconds } from "../lib/format.js";

export function ImportView({ editor }: { editor: Editor }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const onUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void editor.importUpload(file);
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <section className="card">
      <h2>Import a video</h2>
      <p className="muted">
        Start from a generated demo clip (with built-in pauses) or upload your own. CUTOS analyzes
        the media, then edits by natural language — every change is validated, non-destructive and
        reversible.
      </p>
      <div className="row">
        <button className="btn btn-primary" onClick={() => void editor.importSample()} disabled={editor.busy !== null}>
          {editor.busy ? <span className="spinner" /> : "Load demo clip"}
        </button>
        <button className="btn" onClick={() => fileRef.current?.click()} disabled={editor.busy !== null}>
          Upload a video…
        </button>
        <input ref={fileRef} type="file" accept="video/*,audio/*" hidden onChange={onUpload} />
      </div>
      {editor.busy && <p className="muted" style={{ marginTop: 12 }}>{editor.busy}</p>}

      {editor.projects.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <h2>Recent projects</h2>
          {editor.projects.map((p) => (
            <div key={p.id} className="history-item">
              <button className="linklike" onClick={() => void editor.openProject(p.id)}>
                {p.name} · {formatSeconds(p.durationMs)}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => void editor.removeProject(p.id)}>
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
