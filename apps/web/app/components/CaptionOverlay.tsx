"use client";

import { useMemo } from "react";
import { getActiveCaptionsAt, type PreviewManifest } from "@cutos/preview";

/** Renders captions active at the current edited-timeline position over the video. */
export function CaptionOverlay({ manifest, currentMs }: { manifest: PreviewManifest; currentMs: number }) {
  const active = useMemo(() => getActiveCaptionsAt(manifest, currentMs), [manifest, currentMs]);
  if (active.length === 0) return null;
  return (
    <div className="caption-overlay" aria-live="polite">
      {active.map((c) => (
        <div key={c.id} className="caption-line">
          {c.text}
        </div>
      ))}
    </div>
  );
}
