"use client";

import type { PreviewManifest } from "@cutos/preview";
import {
  clamp,
  type PreviewBackend,
  type PreviewBackendEvents,
  type PreviewState,
} from "./backend.js";
import { HtmlVideoPreviewBackend } from "./htmlVideoBackend.js";

export type PreviewListener = (state: PreviewState) => void;

export interface PreviewSessionOptions {
  video: HTMLVideoElement;
  sourceUrl: string;
  manifest: PreviewManifest;
}

const TIME_EMIT_INTERVAL_MS = 90;

/**
 * Owns the playback backend and preview state for a project. The playhead is
 * updated at animation-frame rate inside the backend but only emitted to React
 * subscribers at a throttled rate, so the component tree never re-renders at
 * 60fps. Rebuilds automatically when the timeline revision changes.
 */
export class PreviewSession {
  private backend: PreviewBackend;
  private manifest: PreviewManifest;
  private listeners = new Set<PreviewListener>();
  private lastTimeEmit = 0;
  private state: PreviewState;

  private signature: string;

  constructor(options: PreviewSessionOptions) {
    this.manifest = options.manifest;
    this.signature = manifestSignature(options.manifest);
    this.state = {
      status: "loading",
      currentMs: 0,
      durationMs: options.manifest.durationMs,
      volume: options.video.volume ?? 1,
      muted: options.video.muted ?? false,
    };

    const events: PreviewBackendEvents = {
      onState: (partial) => {
        this.state = { ...this.state, ...partial };
        this.notify();
      },
      onTime: (ms) => {
        this.state = { ...this.state, currentMs: ms };
        const now = Date.now();
        if (now - this.lastTimeEmit >= TIME_EMIT_INTERVAL_MS) {
          this.lastTimeEmit = now;
          this.notify();
        }
      },
      onEnded: () => undefined,
    };

    this.backend = new HtmlVideoPreviewBackend(options.video, options.sourceUrl, events);
    void this.backend.load(this.manifest);
  }

  get backendName(): string {
    return this.backend.name;
  }

  getState(): PreviewState {
    return this.state;
  }

  subscribe(listener: PreviewListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.state);
  }

  /** Swap in a new manifest (e.g. after apply/undo/redo, or an ephemeral preview). */
  async update(manifest: PreviewManifest): Promise<void> {
    const nextSignature = manifestSignature(manifest);
    if (nextSignature === this.signature) return;
    this.signature = nextSignature;
    this.manifest = manifest;
    this.state = {
      ...this.state,
      durationMs: manifest.durationMs,
      currentMs: clamp(this.state.currentMs, 0, manifest.durationMs),
    };
    await this.backend.load(manifest);
    this.notify();
  }

  play(): void {
    void this.backend.play();
  }
  pause(): void {
    this.backend.pause();
  }
  toggle(): void {
    if (this.state.status === "playing") this.pause();
    else this.play();
  }
  seek(timelineMs: number): void {
    this.backend.seek(timelineMs);
  }
  setVolume(volume: number): void {
    this.backend.setVolume(volume);
  }
  setMuted(muted: boolean): void {
    this.backend.setMuted(muted);
  }

  destroy(): void {
    this.backend.destroy();
    this.listeners.clear();
  }
}

/** Cheap content signature so ephemeral previews (same revision) still reload. */
function manifestSignature(manifest: PreviewManifest): string {
  const segs = manifest.segments.map((s) => `${s.sourceInMs}-${s.sourceOutMs}@${s.speed}`).join(",");
  return `${manifest.timelineRevision}|${manifest.durationMs}|${segs}`;
}
