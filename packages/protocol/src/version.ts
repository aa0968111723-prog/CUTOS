/**
 * Protocol version constants, with NO Node built-in imports.
 *
 * Split out of `protocol.ts` deliberately: that file needs `node:crypto` for
 * the contract fingerprint, and a client bundle that imported it would fail to
 * build. The UI only ever needs the version strings, so they live here and
 * `protocol.ts` re-uses them — one source of truth, still bundleable.
 */

/** The protocol this build speaks. */
export const CUTOS_PROTOCOL_VERSION = "cutos.agent.v2" as const;

/** Legacy protocol kept alive so existing v1 AIOS agents do not break. */
export const CUTOS_PROTOCOL_VERSION_V1 = "cutos.agent.v1" as const;

/** Every protocol version this build can serve/consume, newest first. */
export const CUTOS_SUPPORTED_PROTOCOLS = [
  CUTOS_PROTOCOL_VERSION,
  CUTOS_PROTOCOL_VERSION_V1,
] as const;
