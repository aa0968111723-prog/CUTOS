"use client";

import type { PreviewManifest } from "@cutos/preview";

export type PreviewStatus =
  | "idle"
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "buffering"
  | "ended"
  | "error";

export interface PreviewState {
  status: PreviewStatus;
  currentMs: number;
  durationMs: number;
  volume: number;
  muted: boolean;
  /** App error code for the i18n layer (never a raw stack trace). */
  errorCode?: string;
}

export interface PreviewBackendEvents {
  /** Merge a partial state update (status/volume/error/…). Throttled by session. */
  onState: (partial: Partial<PreviewState>) => void;
  /** High-frequency playhead position in edited-timeline ms. */
  onTime: (timelineMs: number) => void;
  onEnded: () => void;
}

/**
 * A pluggable playback backend. `HtmlVideoPreviewBackend` is the reliable
 * default; a `WebCodecsPreviewBackend` can be added later behind the same
 * contract without touching the session or UI.
 */
export interface PreviewBackend {
  readonly name: string;
  load(manifest: PreviewManifest): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(timelineMs: number): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  destroy(): void;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
