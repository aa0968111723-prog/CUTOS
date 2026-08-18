"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PreviewManifest } from "@cutos/preview";
import { PreviewSession } from "./session.js";
import type { PreviewState } from "./backend.js";

export interface PreviewControls {
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (timelineMs: number) => void;
  setVolume: (volume: number) => void;
  setMuted: (muted: boolean) => void;
}

const INITIAL: PreviewState = {
  status: "idle",
  currentMs: 0,
  durationMs: 0,
  volume: 1,
  muted: false,
};

/**
 * Binds a {@link PreviewSession} to a <video> element for the given manifest.
 * The session is created once per source and reloaded when the manifest content
 * changes (apply/undo/redo or an ephemeral operation preview). Playhead updates
 * arrive throttled, so this hook does not re-render at frame rate.
 */
export function usePreview(manifest: PreviewManifest, sourceUrl: string) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sessionRef = useRef<PreviewSession | null>(null);
  const [state, setState] = useState<PreviewState>(INITIAL);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const session = new PreviewSession({ video, sourceUrl, manifest });
    sessionRef.current = session;
    const unsubscribe = session.subscribe(setState);
    return () => {
      unsubscribe();
      session.destroy();
      sessionRef.current = null;
    };
    // Recreate only when the underlying source changes; manifest updates are
    // handled by the effect below (manifest is intentionally not a dependency).
  }, [sourceUrl]);

  useEffect(() => {
    void sessionRef.current?.update(manifest);
  }, [manifest]);

  const controls = useMemo<PreviewControls>(
    () => ({
      play: () => sessionRef.current?.play(),
      pause: () => sessionRef.current?.pause(),
      toggle: () => sessionRef.current?.toggle(),
      seek: (ms) => sessionRef.current?.seek(ms),
      setVolume: (v) => sessionRef.current?.setVolume(v),
      setMuted: (m) => sessionRef.current?.setMuted(m),
    }),
    [],
  );

  return { videoRef, state, controls };
}
