import { NextResponse } from "next/server";
import { ConcurrencyError, ProjectNotFoundError } from "@cutos/project-store";

/** An error carrying an intended HTTP status code. */
export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly extra?: Record<string, unknown>) {
    super(message);
    this.name = "HttpError";
  }
}

export function json<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

export function errorResponse(status: number, message: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

/** Map thrown errors to appropriate HTTP responses. */
export function handleError(error: unknown): NextResponse {
  if (error instanceof HttpError) {
    return errorResponse(error.status, error.message, error.extra);
  }
  if (error instanceof ProjectNotFoundError) {
    return errorResponse(404, error.message);
  }
  if (error instanceof ConcurrencyError) {
    return errorResponse(409, error.message);
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return errorResponse(500, message);
}
