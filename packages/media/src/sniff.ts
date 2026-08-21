/**
 * Container sniffing from the first bytes of a file.
 *
 * A declared `Content-Type` is client-supplied and therefore not evidence: a
 * mobile browser guesses it from the file extension, and an attacker simply
 * lies. ffprobe is the real gate, but it runs in a background job long after
 * the request that could have refused the file. Sniffing lets `finalize`
 * answer 415 immediately, from bytes the uploader actually sent.
 *
 * This is deliberately a cheap allow-list over container magic, not a codec
 * decision — anything it accepts still has to survive ffprobe.
 */

export type SniffedContainer =
  | "mp4"
  | "matroska"
  | "webm"
  | "avi"
  | "wav"
  | "ogg"
  | "flac"
  | "mpegts"
  | "mp3"
  | "aiff"
  | "flv"
  | "asf"
  | "amr"
  | "caf";

export interface SniffResult {
  container: SniffedContainer | null;
  /** True when the bytes look like a media container we are willing to probe. */
  looksLikeMedia: boolean;
}

/** How many leading bytes {@link sniffContainer} needs. */
export const SNIFF_BYTES = 4096;

const ascii = (buf: Uint8Array, start: number, length: number): string =>
  String.fromCharCode(...buf.subarray(start, start + length));

/**
 * Identify the container of `head`, the first {@link SNIFF_BYTES} bytes of a
 * file. Returns `looksLikeMedia: false` for anything unrecognized rather than
 * guessing.
 */
export function sniffContainer(head: Uint8Array): SniffResult {
  const found = detect(head);
  return { container: found, looksLikeMedia: found !== null };
}

function detect(head: Uint8Array): SniffedContainer | null {
  if (head.length < 12) return null;

  // ISO base media (mp4/m4a/mov/3gp): a `ftyp` box near the start.
  if (ascii(head, 4, 4) === "ftyp") return "mp4";

  // RIFF containers carry their form at offset 8.
  if (ascii(head, 0, 4) === "RIFF") {
    const form = ascii(head, 8, 4);
    if (form === "AVI ") return "avi";
    if (form === "WAVE") return "wav";
    return null;
  }

  // EBML — Matroska and WebM share a header; the DocType tells them apart.
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return ascii(head, 0, Math.min(head.length, 256)).includes("webm") ? "webm" : "matroska";
  }

  if (ascii(head, 0, 4) === "OggS") return "ogg";
  if (ascii(head, 0, 4) === "fLaC") return "flac";
  if (ascii(head, 0, 4) === "FORM" && ascii(head, 8, 4).startsWith("AIF")) return "aiff";
  if (ascii(head, 0, 3) === "FLV") return "flv";
  if (ascii(head, 0, 4) === "#!AM") return "amr";
  if (ascii(head, 0, 4) === "caff") return "caf";

  // ASF / WMV / WMA GUID.
  if (head[0] === 0x30 && head[1] === 0x26 && head[2] === 0xb2 && head[3] === 0x75) return "asf";

  // MPEG-TS: 0x47 sync bytes every 188 bytes. Require three in a row so a
  // stray 'G' at offset 0 in a text file cannot pass.
  if (head[0] === 0x47 && head[188] === 0x47 && head[376] === 0x47) return "mpegts";

  // MP3: an ID3 tag, or an MPEG audio frame sync with a valid layer/version.
  if (ascii(head, 0, 3) === "ID3") return "mp3";
  if (head[0] === 0xff && ((head[1] ?? 0) & 0xe6) >= 0xe2) return "mp3";

  return null;
}
