import { EDIT_DSL_VERSION } from "./operations.js";

/**
 * Migrate a raw Edit Plan of any known prior version up to the current schema.
 * v1 → v2 is structurally compatible (v1's `reason` field is now part of the
 * shared operation metadata), so migration only bumps the version tag. Unknown
 * input is returned untouched for the validator to reject.
 */
export function migrateEditPlan(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;
  const record = input as Record<string, unknown>;

  if (record.version === 1) {
    return { ...record, version: EDIT_DSL_VERSION };
  }

  return input;
}
