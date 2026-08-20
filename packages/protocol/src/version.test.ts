import { describe, expect, it } from "vitest";
import {
  CUTOS_PROTOCOL_VERSION,
  CUTOS_PROTOCOL_VERSION_V1,
  CUTOS_SUPPORTED_PROTOCOLS,
} from "./version.js";
import * as protocol from "./protocol.js";

/**
 * `version.ts` exists so a browser bundle can read the protocol version without
 * importing `protocol.ts` (which needs node:crypto for the contract
 * fingerprint). Two files means two chances to drift, so this test pins them
 * together — and `protocol.ts` stays self-contained, because it is mirrored
 * byte-for-byte into aa0968111723-prog/ai_os and cannot import a sibling.
 */
describe("browser-safe version module", () => {
  it("declares the same version as the full protocol module", () => {
    expect(CUTOS_PROTOCOL_VERSION).toBe(protocol.CUTOS_PROTOCOL_VERSION);
    expect(CUTOS_PROTOCOL_VERSION_V1).toBe(protocol.CUTOS_PROTOCOL_VERSION_V1);
    expect([...CUTOS_SUPPORTED_PROTOCOLS]).toEqual([...protocol.CUTOS_SUPPORTED_PROTOCOLS]);
  });

  it("imports nothing from Node, so it is safe in a client bundle", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./version.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toMatch(/require\(/);
    expect(source).not.toMatch(/\bzod\b/);
  });
});
