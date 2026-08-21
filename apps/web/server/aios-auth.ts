import { timingSafeEqual } from "node:crypto";

/**
 * Authentication for the AIOS bridge surface.
 *
 * This module exists because the bridge shipped with none. `POST /api/aios/invoke`
 * accepted every governed capability — `apply_edit_plan`, `undo`, `redo`,
 * `export` — from any HTTP caller, for any project id, with no credential at
 * all. ai_os had been sending `Authorization: Bearer $CUTOS_API_KEY` the whole
 * time; CUTOS simply never read it. The only auth check in the repository lived
 * inside `aios-http.test.ts`, so the committed contract's `unauthorized`
 * scenario passed while production was open.
 *
 * Two deliberate choices:
 *
 * 1. **The check lives here, not in the Next route.** A guard mounted only on
 *    the transport is a guard the next transport forgets — which is exactly how
 *    the test server ended up simulating auth that production did not have.
 *    `handleInvokeBody` takes the credential and refuses without it, so every
 *    caller goes through the same door.
 * 2. **Unconfigured fails closed.** With no `CUTOS_API_KEY` the bridge refuses
 *    capability calls rather than serving them openly. An operator who has not
 *    set a key has not decided to publish an unauthenticated edit endpoint —
 *    and "we default to open" is how the hole existed in the first place. The
 *    error says what to set.
 *
 * `GET /api/aios/health` stays open: it is a version handshake carrying only
 * constants already public in both repositories' source. Requiring a credential
 * there would collapse 「版本不相容」 and 「認證失敗」 into one unreachable state,
 * which is the silent-failure mode the protocol forbids.
 */

export class AiosUnauthorizedError extends Error {
  override readonly name = "AiosUnauthorizedError";
  constructor(
    /** zh-TW key for the UI; the message is for operator logs only. */
    readonly messageKey: string,
    message: string,
  ) {
    super(message);
  }
}

/** The credential a caller presented, however the transport carried it. */
export interface AiosCredential {
  authorization?: string | null;
  apiKey?: string | null;
}

export function readAiosKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = env.CUTOS_API_KEY?.trim();
  return key ? key : undefined;
}

export function aiosAuthConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return readAiosKey(env) !== undefined;
}

/** Constant-time compare; a length mismatch is reported without leaking length. */
function keyMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // Still burn a comparison so the failure cost does not depend on length.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function presented(credential: AiosCredential | undefined): string | undefined {
  const header = credential?.authorization;
  if (typeof header === "string" && /^bearer\s+/i.test(header)) {
    const token = header.replace(/^bearer\s+/i, "").trim();
    if (token) return token;
  }
  const apiKey = credential?.apiKey;
  if (typeof apiKey === "string" && apiKey.trim()) return apiKey.trim();
  return undefined;
}

/**
 * Refuse unless the caller presented the configured key.
 *
 * Throws {@link AiosUnauthorizedError}; callers map it to the protocol's
 * `UNAUTHORIZED` so the peer gets a typed code rather than an HTML error page.
 */
export function assertAiosAuthorized(
  credential: AiosCredential | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const expected = readAiosKey(env);
  if (!expected) {
    throw new AiosUnauthorizedError(
      "aios.error.bridgeKeyMissing",
      "CUTOS_API_KEY is not set; the AIOS bridge refuses capability calls until it is",
    );
  }
  const token = presented(credential);
  if (!token || !keyMatches(token, expected)) {
    throw new AiosUnauthorizedError("aios.error.unauthorized", "invalid AIOS bridge credential");
  }
}

/** Pull the credential out of a Fetch API request without copying the whole header set. */
export function credentialFromHeaders(headers: Headers): AiosCredential {
  return {
    authorization: headers.get("authorization"),
    apiKey: headers.get("x-api-key"),
  };
}
