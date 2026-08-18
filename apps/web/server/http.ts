import { NextResponse } from "next/server";
import { HttpError, type AppErrorCode } from "./errors.js";
import { logger } from "./logger.js";

export { HttpError };

/** Read the `name` of an unknown error without relying on cross-bundle instanceof. */
function errorName(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "name" in error
    ? String((error as { name?: unknown }).name)
    : undefined;
}

export function json<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

export function errorResponse(
  status: number,
  code: AppErrorCode,
  message?: string,
  extra?: Record<string, unknown>,
) {
  return NextResponse.json({ code, message: message ?? code, ...extra }, { status });
}

/**
 * Map thrown errors to HTTP responses with a stable `code`. The technical
 * message is included for debugging but the client renders zh-TW copy keyed by
 * `code`, never raw internals (e.g. FFmpeg stderr).
 */
export function handleError(error: unknown): NextResponse {
  // Match by `name` rather than instanceof so it is robust across duplicate
  // module instances that a bundler may produce.
  const name = errorName(error);
  const message = error instanceof Error ? error.message : "Unexpected error";

  if (error instanceof HttpError || name === "HttpError") {
    const e = error as HttpError;
    return errorResponse(e.status ?? 500, e.code ?? "INTERNAL", e.message, e.extra);
  }
  if (name === "ProjectNotFoundError") {
    return errorResponse(404, "PROJECT_NOT_FOUND", message);
  }
  if (name === "ConcurrencyError") {
    return errorResponse(409, "CONCURRENCY_CONFLICT", message);
  }
  logger.error("unhandled error", { message });
  return errorResponse(500, "INTERNAL", message);
}
