"use client";

import { useRef, type RefObject } from "react";
import type { PreviewManifest } from "@cutos/preview";
import type { PreviewControls } from "../preview/usePreview.js";
import type { PreviewState } from "../preview/backend.js";
import { CaptionOverlay } from "./CaptionOverlay.js";
import { t, type MessageKey } from "../i18n/index.js";
import { formatMs } from "../lib/format.js";

interface EditedPreviewPlayerProps {
  videoRef: RefObject<HTMLVideoElement>;
  state: PreviewState;
  controls: PreviewControls;
  manifest: PreviewManifest;
  mode: "edited" | "original";
  onModeChange: (mode: "edited" | "original") => void;
  overrideActive: boolean;
  onExitOverride: () => void;
}

export function EditedPreviewPlayer({
  videoRef,
  state,
  controls,
  manifest,
  mode,
  onModeChange,
  overrideActive,
  onExitOverride,
}: EditedPreviewPlayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const statusKey = `player.status.${state.status}` as MessageKey;
  const isPlaying = state.status === "playing";

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === " ") {
      e.preventDefault();
      controls.toggle();
    } else if (e.key === "ArrowRight") {
      controls.seek(Math.min(state.durationMs, state.currentMs + 5000));
    } else if (e.key === "ArrowLeft") {
      controls.seek(Math.max(0, state.currentMs - 5000));
    }
  };

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>{t("player.title")}</h2>
        {!overrideActive && (
          <div className="tabs" role="tablist" aria-label={t("player.title")}>
            <button
              role="tab"
              aria-selected={mode === "edited"}
              className={`tab ${mode === "edited" ? "active" : ""}`}
              onClick={() => onModeChange("edited")}
            >
              {t("player.editedTab")}
            </button>
            <button
              role="tab"
              aria-selected={mode === "original"}
              className={`tab ${mode === "original" ? "active" : ""}`}
              onClick={() => onModeChange("original")}
            >
              {t("player.originalTab")}
            </button>
          </div>
        )}
      </div>

      {overrideActive && (
        <div className="preview-banner">
          <span>{t("player.previewingOp")}</span>
          <button className="btn btn-sm" onClick={onExitOverride}>
            {t("player.exitPreview")}
          </button>
        </div>
      )}

      <div ref={containerRef} className="preview-stage" tabIndex={0} onKeyDown={onKeyDown}>
        <video ref={videoRef} className="player" playsInline preload="auto" />
        <CaptionOverlay manifest={manifest} currentMs={state.currentMs} />
        {state.status === "error" && (
          <div className="preview-error">
            <span>{t("player.status.error")}</span>
            <button className="btn btn-sm" onClick={() => controls.seek(0)}>
              {t("player.reload")}
            </button>
          </div>
        )}
      </div>

      <div className="transport">
        <button
          className="btn btn-icon"
          onClick={() => controls.toggle()}
          aria-label={isPlaying ? t("player.pause") : t("player.play")}
        >
          {isPlaying ? "⏸" : "▶"}
        </button>
        <span className="time" aria-hidden>
          {formatMs(state.currentMs)} / {formatMs(state.durationMs)}
        </span>
        <input
          className="scrubber"
          type="range"
          min={0}
          max={Math.max(1, state.durationMs)}
          value={Math.min(state.currentMs, state.durationMs)}
          onChange={(e) => controls.seek(Number(e.target.value))}
          aria-label={t("player.title")}
        />
        <button
          className="btn btn-icon"
          onClick={() => controls.setMuted(!state.muted)}
          aria-label={state.muted ? t("player.unmute") : t("player.mute")}
        >
          {state.muted ? "🔇" : "🔊"}
        </button>
        <button
          className="btn btn-icon"
          onClick={() => void containerRef.current?.requestFullscreen?.()}
          aria-label={t("player.fullscreen")}
        >
          ⛶
        </button>
        <span className="preview-status">{t(statusKey)}</span>
      </div>
    </div>
  );
}
