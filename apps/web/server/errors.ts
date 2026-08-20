/**
 * Stable, machine-readable error codes. The API returns a `code`; the client
 * maps it to natural zh-TW copy. Human/technical `message` is for logs/debug
 * only — never the primary thing shown to end users.
 */
/**
 * Every app error code, as a runtime list.
 *
 * A `type` union alone cannot be enumerated by a test, so the i18n suite could
 * only sample a handful of codes by hand — and a new code could ship with no
 * zh-TW copy and surface to the user as the generic 「發生問題，請稍後再試。」.
 * Deriving the type from this array makes the copy check exhaustive.
 */
export const APP_ERROR_CODES = [
  "PROJECT_NOT_FOUND",
  "TIMELINE_NOT_FOUND",
  "MEDIA_UNSUPPORTED",
  "MEDIA_MISSING",
  "UPLOAD_TOO_LARGE",
  "UPLOAD_INVALID",
  "JOB_NOT_FOUND",
  "JOB_FAILED",
  "STALE_EDIT_PLAN",
  "NO_PENDING_PLAN",
  "EMPTY_TIMELINE",
  "OPERATION_NOT_FOUND",
  "UNSUPPORTED_OPERATION",
  "PREVIEW_UNSUPPORTED",
  "EXPORT_FAILED",
  "VALIDATION_FAILED",
  "CONCURRENCY_CONFLICT",
  /** AIOS orchestration is not configured or not reachable. */
  "AIOS_UNAVAILABLE",
  "INTERNAL",
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

/** An error carrying an intended HTTP status code and a stable app error code. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: AppErrorCode,
    message?: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = "HttpError";
  }
}
