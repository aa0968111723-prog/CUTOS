"use client";

import { useMemo } from "react";
import type { Editor } from "../hooks/useEditor.js";
import type { ProjectDTO } from "../lib/types.js";
import { formatMs } from "../lib/format.js";
import { Strip, type StripItem } from "./Strip.js";

export function TimelinePanel({ editor, project }: { editor: Editor; project: ProjectDTO }) {
  const sourceStrip = useMemo<StripItem[]>(() => {
    const total = project.source.durationMs || 1;
    return (project.analysis?.silences ?? []).map((s) => ({
      kind: "silence",
      leftPct: (s.startMs / total) * 100,
      widthPct: ((s.endMs - s.startMs) / total) * 100,
      title: `Pause ${formatMs(s.startMs)}–${formatMs(s.endMs)}`,
    }));
  }, [project]);

  const editedStrip = useMemo<StripItem[]>(() => {
    const total = project.timeline.durationMs || 1;
    let cursor = 0;
    return project.timeline.clips.map((clip) => {
      const leftPct = (cursor / total) * 100;
      const widthPct = (clip.outputDurationMs / total) * 100;
      cursor += clip.outputDurationMs;
      return {
        kind: clip.speed !== 1 ? "speed" : "keep",
        leftPct,
        widthPct,
        title: `Clip ${formatMs(clip.sourceInMs)}–${formatMs(clip.sourceOutMs)}${clip.speed !== 1 ? ` @ ${clip.speed}x` : ""}`,
      };
    });
  }, [project]);

  return (
    <div className="card">
      <h2>Semantic timeline</h2>
      <p className="muted" style={{ marginTop: 0 }}>Source with detected pauses</p>
      <Strip items={[{ kind: "keep", leftPct: 0, widthPct: 100, title: "source" }, ...sourceStrip]} />
      <p className="muted" style={{ marginBottom: 0, marginTop: 16 }}>Edited timeline</p>
      <Strip items={editedStrip} />
      <div className="legend">
        <span><i className="swatch" style={{ background: "#2563eb" }} /> kept</span>
        <span><i className="swatch" style={{ background: "#7c3aed" }} /> speed</span>
        <span>
          <i className="swatch" style={{ background: "repeating-linear-gradient(45deg,#f8717188,#f8717188 4px,transparent 4px,transparent 8px)" }} /> pause
        </span>
      </div>

      {(project.timeline.markers.length > 0 || project.timeline.captions.length > 0) && (
        <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
          {project.timeline.captions.length} caption(s) · {project.timeline.markers.length} marker(s)
        </div>
      )}

      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn" onClick={() => void editor.undo()} disabled={!project.canUndo || editor.busy !== null}>
          Undo
        </button>
        <button className="btn" onClick={() => void editor.redo()} disabled={!project.canRedo || editor.busy !== null}>
          Redo
        </button>
      </div>

      {project.operationLog.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <p className="muted" style={{ margin: "0 0 6px" }}>History</p>
          {project.operationLog.slice(-6).reverse().map((entry) => (
            <div key={entry.id} className="history-item">
              <span>
                <span className="pill">{entry.kind}</span> {entry.summary ?? "(timeline change)"}
              </span>
              <span className="muted">rev {entry.revision}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
