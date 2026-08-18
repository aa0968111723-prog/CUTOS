"use client";

import {
  getActiveSegmentAt,
  timelineTimeToSourceTime,
  type PreviewManifest,
} from "@cutos/preview";
import { clamp, type PreviewBackend, type PreviewBackendEvents } from "./backend.js";
import { supportsRequestVideoFrameCallback } from "./capabilities.js";

const BOUNDARY_EPSILON_MS = 40;

/**
 * Plays an edited timeline by driving a single <video> of the original source
 * through the manifest's segments: play a segment's source range, then seek to
 * the next segment's source start (skipping deleted ranges) and adjust
 * playbackRate for speed segments. Uses requestVideoFrameCallback when
 * available, otherwise requestAnimationFrame — clip boundaries stay tight.
 */
export class HtmlVideoPreviewBackend implements PreviewBackend {
  readonly name = "html-video";

  private manifest: PreviewManifest | null = null;
  private currentMs = 0;
  private playing = false;
  private disposed = false;
  private seeking = false;
  private loopHandle: number | null = null;
  private readonly useRvfc: boolean;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly sourceUrl: string,
    private readonly events: PreviewBackendEvents,
  ) {
    this.useRvfc = supportsRequestVideoFrameCallback();
    this.attach();
  }

  private attach(): void {
    const v = this.video;
    v.addEventListener("loadedmetadata", this.onLoadedMetadata);
    v.addEventListener("waiting", this.onWaiting);
    v.addEventListener("playing", this.onPlaying);
    v.addEventListener("seeked", this.onSeeked);
    v.addEventListener("error", this.onError);
  }

  private detach(): void {
    const v = this.video;
    v.removeEventListener("loadedmetadata", this.onLoadedMetadata);
    v.removeEventListener("waiting", this.onWaiting);
    v.removeEventListener("playing", this.onPlaying);
    v.removeEventListener("seeked", this.onSeeked);
    v.removeEventListener("error", this.onError);
  }

  private onLoadedMetadata = () => {
    if (this.manifest) this.events.onState({ status: this.playing ? "playing" : "ready" });
  };
  private onWaiting = () => {
    if (this.playing) this.events.onState({ status: "buffering" });
  };
  private onPlaying = () => {
    if (this.playing) this.events.onState({ status: "playing" });
  };
  private onSeeked = () => {
    this.seeking = false;
  };
  private onError = () => {
    this.events.onState({ status: "error", errorCode: "PREVIEW_UNSUPPORTED" });
  };

  async load(manifest: PreviewManifest): Promise<void> {
    this.manifest = manifest;
    if (this.video.src !== this.sourceUrl) {
      this.video.src = this.sourceUrl;
      this.video.load();
    }
    this.currentMs = clamp(this.currentMs, 0, manifest.durationMs);
    this.positionAt(this.currentMs);
    this.events.onState({
      status: this.playing ? "playing" : "ready",
      durationMs: manifest.durationMs,
      currentMs: this.currentMs,
      volume: this.video.volume,
      muted: this.video.muted,
    });
  }

  private positionAt(timelineMs: number): void {
    if (!this.manifest) return;
    const segment = getActiveSegmentAt(this.manifest.segments, timelineMs);
    if (!segment) return;
    const loc = timelineTimeToSourceTime(this.manifest.segments, timelineMs);
    if (!loc) return;
    this.currentMs = timelineMs;
    this.video.playbackRate = segment.speed;
    this.seeking = true;
    this.video.currentTime = loc.sourceMs / 1000;
  }

  async play(): Promise<void> {
    if (!this.manifest || this.manifest.segments.length === 0) return;
    if (this.currentMs >= this.manifest.durationMs) this.positionAt(0);
    const segment = getActiveSegmentAt(this.manifest.segments, this.currentMs);
    if (segment) this.video.playbackRate = segment.speed;
    this.playing = true;
    try {
      await this.video.play();
    } catch {
      // Autoplay rejection etc.; reflect paused state.
      this.playing = false;
      this.events.onState({ status: "paused" });
      return;
    }
    this.events.onState({ status: "playing" });
    this.startLoop();
  }

  pause(): void {
    this.playing = false;
    this.video.pause();
    this.stopLoop();
    this.events.onState({ status: "paused" });
  }

  seek(timelineMs: number): void {
    if (!this.manifest) return;
    const clamped = clamp(timelineMs, 0, this.manifest.durationMs);
    this.positionAt(clamped);
    this.events.onTime(clamped);
    if (!this.playing) {
      this.events.onState({ status: clamped >= this.manifest.durationMs ? "ended" : "paused" });
    }
  }

  setVolume(volume: number): void {
    this.video.volume = clamp(volume, 0, 1);
    this.events.onState({ volume: this.video.volume });
  }

  setMuted(muted: boolean): void {
    this.video.muted = muted;
    this.events.onState({ muted });
  }

  destroy(): void {
    this.disposed = true;
    this.stopLoop();
    this.detach();
    this.video.pause();
  }

  private startLoop(): void {
    this.stopLoop();
    this.scheduleNext();
  }

  private stopLoop(): void {
    if (this.loopHandle === null) return;
    if (this.useRvfc) {
      this.video.cancelVideoFrameCallback(this.loopHandle);
    } else {
      cancelAnimationFrame(this.loopHandle);
    }
    this.loopHandle = null;
  }

  private scheduleNext(): void {
    if (this.disposed || !this.playing) return;
    if (this.useRvfc) {
      this.loopHandle = this.video.requestVideoFrameCallback(this.tick);
    } else {
      this.loopHandle = requestAnimationFrame(this.tick);
    }
  }

  private tick = () => {
    if (this.disposed || !this.manifest || !this.playing) return;
    if (this.seeking) {
      this.scheduleNext();
      return;
    }
    const segment = getActiveSegmentAt(this.manifest.segments, this.currentMs);
    if (segment) {
      const sourceMs = this.video.currentTime * 1000;
      if (sourceMs >= segment.sourceOutMs - BOUNDARY_EPSILON_MS) {
        const next = this.manifest.segments[segment.index + 1];
        if (next) {
          this.currentMs = next.timelineInMs;
          this.video.playbackRate = next.speed;
          this.seeking = true;
          this.video.currentTime = next.sourceInMs / 1000;
        } else {
          this.playing = false;
          this.currentMs = this.manifest.durationMs;
          this.video.pause();
          this.events.onTime(this.currentMs);
          this.events.onState({ status: "ended", currentMs: this.currentMs });
          this.events.onEnded();
          this.stopLoop();
          return;
        }
      } else {
        this.currentMs = segment.timelineInMs + (sourceMs - segment.sourceInMs) / segment.speed;
        this.events.onTime(this.currentMs);
      }
    }
    this.scheduleNext();
  };
}
