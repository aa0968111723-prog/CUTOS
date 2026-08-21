import { describe, expect, it } from "vitest";
import { sniffContainer } from "./sniff.js";

function head(bytes: (number | string)[], length = 512): Uint8Array {
  const out = new Uint8Array(length);
  let i = 0;
  for (const part of bytes) {
    if (typeof part === "number") {
      out[i] = part;
      i += 1;
    } else {
      for (const ch of part) {
        out[i] = ch.charCodeAt(0);
        i += 1;
      }
    }
  }
  return out;
}

describe("sniffContainer", () => {
  it("recognizes the containers a phone camera actually produces", () => {
    expect(sniffContainer(head([0, 0, 0, 0x20, "ftypisom"])).container).toBe("mp4");
    expect(sniffContainer(head([0, 0, 0, 0x18, "ftypmp42"])).container).toBe("mp4");
    // Android/Samsung 3GP capture and QuickTime both use the same box.
    expect(sniffContainer(head([0, 0, 0, 0x14, "ftyp3gp4"])).looksLikeMedia).toBe(true);
    expect(sniffContainer(head([0, 0, 0, 0x14, "ftypqt  "])).looksLikeMedia).toBe(true);
  });

  it("recognizes matroska, webm, avi, wav, ogg and flac", () => {
    expect(sniffContainer(head([0x1a, 0x45, 0xdf, 0xa3, "Bwebm"])).container).toBe("webm");
    expect(sniffContainer(head([0x1a, 0x45, 0xdf, 0xa3, "Bmatroska"])).container).toBe(
      "matroska",
    );
    expect(sniffContainer(head(["RIFF", 0, 0, 0, 0, "AVI LIST"])).container).toBe("avi");
    expect(sniffContainer(head(["RIFF", 0, 0, 0, 0, "WAVEfmt "])).container).toBe("wav");
    expect(sniffContainer(head(["OggS", 0, 0, 0, 0, 0, 0, 0, 0])).container).toBe("ogg");
    expect(sniffContainer(head(["fLaC", 0, 0, 0, 0x22, 0, 0, 0, 0])).container).toBe("flac");
  });

  it("requires repeating sync bytes before calling something MPEG-TS", () => {
    const ts = new Uint8Array(512);
    ts[0] = 0x47;
    ts[188] = 0x47;
    ts[376] = 0x47;
    expect(sniffContainer(ts).container).toBe("mpegts");

    // A single 'G' at offset 0 is not a transport stream.
    const notTs = head(["Gopher protocol document"]);
    expect(notTs[0]).toBe(0x47);
    expect(sniffContainer(notTs).looksLikeMedia).toBe(false);
  });

  it("rejects a forged content-type: a script renamed to .mp4 is not media", () => {
    const shellScript = head(["#!/bin/sh\nrm -rf /\n"]);
    expect(sniffContainer(shellScript)).toEqual({ container: null, looksLikeMedia: false });

    const html = head(["<!doctype html><html><body>hi</body></html>"]);
    expect(sniffContainer(html).looksLikeMedia).toBe(false);

    const zip = head([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(sniffContainer(zip).looksLikeMedia).toBe(false);

    // A RIFF container that is not audio/video (e.g. a WebP image) is refused
    // even though its magic matches the outer format.
    expect(sniffContainer(head(["RIFF", 0, 0, 0, 0, "WEBPVP8 "])).looksLikeMedia).toBe(false);
  });

  it("does not crash or guess on a truncated head", () => {
    expect(sniffContainer(new Uint8Array(0)).looksLikeMedia).toBe(false);
    expect(sniffContainer(new Uint8Array([0, 0, 0])).looksLikeMedia).toBe(false);
  });
});
