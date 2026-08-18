"use client";

/**
 * Runtime browser capability detection (no user-agent sniffing). The preview
 * engine uses these to pick a backend and the smoothest playhead loop.
 */
export function supportsRequestVideoFrameCallback(): boolean {
  return (
    typeof HTMLVideoElement !== "undefined" &&
    typeof (HTMLVideoElement.prototype as unknown as Record<string, unknown>)
      .requestVideoFrameCallback === "function"
  );
}

export function supportsWebCodecs(): boolean {
  return typeof (globalThis as Record<string, unknown>).VideoDecoder !== "undefined";
}

export function supportsMediaSource(): boolean {
  return typeof (globalThis as Record<string, unknown>).MediaSource !== "undefined";
}
