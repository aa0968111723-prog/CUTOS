"use client";

import { useState } from "react";
import type { Editor } from "../hooks/useEditor.js";
import type { AgentTurnDTO, FrameCardDTO, SuggestedActionDTO } from "../lib/types.js";
import { formatClock } from "../lib/format.js";
import { t } from "../i18n/index.js";

const SUGGESTIONS: string[] = [
  t("suggestions.removeLongPauses"),
  t("suggestions.removeOverOneSecond"),
  t("suggestions.faster"),
];

export function AgentPanel({
  editor,
  playheadMs,
  previewMode,
  onSeek,
}: {
  editor: Editor;
  playheadMs: number;
  previewMode: "edited" | "original";
  onSeek: (ms: number) => void;
}) {
  const [instruction, setInstruction] = useState("");
  const disabled = editor.busy !== null;
  const project = editor.project;

  const send = (text: string, action?: SuggestedActionDTO) => {
    if (!project) return;
    void editor.sendInstruction(text, {
      playheadMs,
      previewMode,
      timelineRevision: project.timelineRevision,
      action,
    });
    setInstruction("");
  };

  return (
    <div className="card chat">
      <h2>{t("agent.title")}</h2>
      <div className="playhead-chip" aria-live="polite">
        <span className="muted">{t("agent.viewing")}</span>
        <strong>{formatClock(playheadMs)}</strong>
        <button
          className="btn btn-ghost btn-sm"
          type="button"
          disabled={disabled || !project}
          onClick={() => send(t("agent.askThisScenePrompt"))}
        >
          {t("agent.askThisScene")}
        </button>
      </div>
      {editor.messages.map((m, i) => (
        <div key={i} className={`msg ${m.role}`}>
          <div>{m.text}</div>
          {m.turn && m.role === "agent" && project && (
            <TurnExtras
              turn={m.turn}
              projectId={project.id}
              disabled={disabled}
              onSeek={onSeek}
              onAction={(action) => send(action.label, action)}
            />
          )}
        </div>
      ))}
      {editor.busy && (
        <div className="msg agent">
          <span className="spinner" /> {editor.busy}
        </div>
      )}
      <div className="composer">
        <input
          value={instruction}
          placeholder={t("agent.placeholder")}
          aria-label={t("agent.placeholder")}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && instruction.trim()) send(instruction);
          }}
          disabled={disabled}
        />
        <button
          className="btn btn-primary"
          onClick={() => instruction.trim() && send(instruction)}
          disabled={disabled || !instruction.trim()}
        >
          {t("agent.send")}
        </button>
      </div>
      <div className="suggestions">
        {SUGGESTIONS.map((s) => (
          <button key={s} onClick={() => send(s)} disabled={disabled}>
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function TurnExtras({
  turn,
  projectId,
  disabled,
  onSeek,
  onAction,
}: {
  turn: AgentTurnDTO;
  projectId: string;
  disabled: boolean;
  onSeek: (ms: number) => void;
  onAction: (action: SuggestedActionDTO) => void;
}) {
  if (turn.type === "edit_plan") return null;
  const grounding = turn.type === "answer" ? turn.grounding : undefined;
  const frames = turn.type === "answer" ? turn.frames : [];
  const actions = turn.type === "answer" ? turn.suggestedActions : [];
  const options = turn.type === "question" ? turn.options : undefined;

  return (
    <div className="turn-extras">
      {grounding && (
        <button
          type="button"
          className="time-chip"
          onClick={() => onSeek(grounding.startMs)}
        >
          {formatClock(grounding.startMs)}–{formatClock(grounding.endMs)}
        </button>
      )}
      {frames.length > 0 && (
        <div className="frame-cards">
          {frames.slice(0, 3).map((frame) => (
            <FrameCard
              key={frame.timeMs}
              projectId={projectId}
              frame={frame}
              disabled={disabled}
              onSeek={onSeek}
              onStart={() =>
                onAction({ type: "trim_from", atMs: frame.timeMs, label: t("agent.fromHere") })
              }
            />
          ))}
        </div>
      )}
      {(actions.length > 0 || (options && options.length > 0)) && (
        <div className="suggestions">
          {actions.map((action) => (
            <button key={action.label} disabled={disabled} onClick={() => onAction(action)}>
              {action.label}
            </button>
          ))}
          {options?.map((option) => (
            <button key={option} disabled={disabled} onClick={() => onAction({ type: "ask_current", label: option })}>
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FrameCard({
  projectId,
  frame,
  disabled,
  onSeek,
  onStart,
}: {
  projectId: string;
  frame: FrameCardDTO;
  disabled: boolean;
  onSeek: (ms: number) => void;
  onStart: () => void;
}) {
  return (
    <div className="frame-card">
      <img
        src={`/api/projects/${projectId}/frames/${frame.timeMs}`}
        alt={frame.description ?? formatClock(frame.timeMs)}
      />
      <div className="frame-card-meta">
        <strong>{formatClock(frame.timeMs)}</strong>
        {frame.description && <p>{frame.description}</p>}
        <div className="frame-card-actions">
          <button type="button" disabled={disabled} onClick={() => onSeek(frame.timeMs)}>
            {t("agent.viewFrame")}
          </button>
          <button type="button" disabled={disabled} onClick={onStart}>
            {t("agent.fromHere")}
          </button>
        </div>
      </div>
    </div>
  );
}
