import { NextResponse } from "next/server";
import { ConcurrencyError, ProjectNotFoundError } from "@cutos/project-store";
import { HttpError, type AppErrorCode } from "./errors.js";
import { logger } from "./logger.js";

export { HttpError };

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
  if (error instanceof HttpError) {
    return errorResponse(error.status, error.code, error.message, error.extra);
  }
  if (error instanceof ProjectNotFoundError) {
    return errorResponse(404, "PROJECT_NOT_FOUND", error.message);
  }
  if (error instanceof ConcurrencyError) {
    return errorResponse(409, "CONCURRENCY_CONFLICT", error.message);
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  logger.error("unhandled error", { message });
  return errorResponse(500, "INTERNAL", message);
}
