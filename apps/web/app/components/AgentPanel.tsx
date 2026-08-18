"use client";

import { useState } from "react";
import type { Editor } from "../hooks/useEditor.js";
import { t } from "../i18n/index.js";

const SUGGESTIONS: string[] = [
  t("suggestions.removeLongPauses"),
  t("suggestions.removeOverOneSecond"),
  t("suggestions.faster"),
];

export function AgentPanel({ editor }: { editor: Editor }) {
  const [instruction, setInstruction] = useState("");
  const disabled = editor.busy !== null;

  const send = (text: string) => {
    void editor.sendInstruction(text);
    setInstruction("");
  };

  return (
    <div className="card chat">
      <h2>{t("agent.title")}</h2>
      {editor.messages.map((m, i) => (
        <div key={i} className={`msg ${m.role}`}>
          {m.text}
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
