/**
 * Minimal explicit Result type. Domain code returns validation failures as
 * data rather than throwing so callers (API routes, workers) can surface
 * structured errors to the user.
 */
export type Result<T, E = string[]> =
  | { ok: true; value: T }
  | { ok: false; errors: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(errors: E): Result<never, E> {
  return { ok: false, errors };
}
