"use client";

import { useMemo, useRef } from "react";
import type { Editor } from "../hooks/useEditor.js";
import type { ProjectDTO } from "../lib/types.js";
import { formatMs } from "../lib/format.js";
import { t } from "../i18n/index.js";
import { Strip, type StripItem } from "./Strip.js";

interface TimelinePanelProps {
  editor: Editor;
  project: ProjectDTO;
  currentMs: number;
  onSeek: (timelineMs: number) => void;
}

export function TimelinePanel({ editor, project, currentMs, onSeek }: TimelinePanelProps) {
  const editedRef = useRef<HTMLDivElement | null>(null);

  const sourceStrip = useMemo<StripItem[]>(() => {
    const total = project.source.durationMs || 1;
    return (project.analysis?.silences ?? []).map((s) => ({
      kind: "silence",
      leftPct: (s.startMs / total) * 100,
      widthPct: ((s.endMs - s.startMs) / total) * 100,
      title: `${formatMs(s.startMs)}–${formatMs(s.endMs)}`,
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
        title: `${formatMs(clip.sourceInMs)}–${formatMs(clip.sourceOutMs)}${clip.speed !== 1 ? ` @ ${clip.speed}x` : ""}`,
      };
    });
  }, [project]);

  const total = project.timeline.durationMs || 1;
  const playheadPct = Math.min(100, (currentMs / total) * 100);

  const seekFromEvent = (clientX: number) => {
    const el = editedRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    onSeek(Math.round(ratio * total));
  };

  return (
    <div className="card">
      <h2>{t("timeline.title")}</h2>
      <p className="muted" style={{ marginTop: 0 }}>{t("timeline.sourceWithPauses")}</p>
      <Strip items={[{ kind: "keep", leftPct: 0, widthPct: 100, title: "source" }, ...sourceStrip]} />

      <p className="muted" style={{ marginBottom: 0, marginTop: 16 }}>{t("timeline.edited")}</p>
      <div
        ref={editedRef}
        className="timeline-seekable"
        role="slider"
        aria-label={t("timeline.edited")}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={Math.min(currentMs, total)}
        tabIndex={0}
        onClick={(e) => seekFromEvent(e.clientX)}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") onSeek(Math.min(total, currentMs + 1000));
          if (e.key === "ArrowLeft") onSeek(Math.max(0, currentMs - 1000));
        }}
      >
        <Strip items={editedStrip} />
        <div className="playhead" style={{ left: `${playheadPct}%` }} />
      </div>

      <div className="legend">
        <span><i className="swatch" style={{ background: "#2563eb" }} /> {t("timeline.legend.kept")}</span>
        <span><i className="swatch" style={{ background: "#7c3aed" }} /> {t("timeline.legend.speed")}</span>
        <span>
          <i className="swatch" style={{ background: "repeating-linear-gradient(45deg,#f8717188,#f8717188 4px,transparent 4px,transparent 8px)" }} /> {t("timeline.legend.pause")}
        </span>
      </div>

      {((project.timeline.markers?.length ?? 0) > 0 || (project.timeline.captions?.length ?? 0) > 0) && (
        <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
          {t("timeline.captionsMarkers", {
            captions: project.timeline.captions?.length ?? 0,
            markers: project.timeline.markers?.length ?? 0,
          })}
        </div>
      )}

      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn" onClick={() => void editor.undo()} disabled={!project.canUndo || editor.busy !== null}>
          {t("timeline.undo")}
        </button>
        <button className="btn" onClick={() => void editor.redo()} disabled={!project.canRedo || editor.busy !== null}>
          {t("timeline.redo")}
        </button>
      </div>

      {project.operationLog.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <p className="muted" style={{ margin: "0 0 6px" }}>{t("timeline.history")}</p>
          {project.operationLog.slice(-6).reverse().map((entry) => (
            <div key={entry.id} className="history-item">
              <span>
                <span className="pill">{entry.kind}</span> {entry.summary ?? t("timeline.timelineChange")}
              </span>
              <span className="muted">rev {entry.revision}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
