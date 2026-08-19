import { createHash } from "node:crypto";

/**
 * Row key for one idempotent capability effect. Hashing keeps the primary key
 * bounded even though an AIOS idempotency key embeds run/step/args material.
 */
export function idempotencyRowId(
  projectId: string,
  capability: string,
  idempotencyKey: string,
): string {
  return createHash("sha256")
    .update(`${projectId} ${capability} ${idempotencyKey}`)
    .digest("hex");
}
