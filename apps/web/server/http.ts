import { NextResponse } from "next/server";
import { ProjectNotFoundError } from "./store.js";

export function json<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

export function errorResponse(status: number, message: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

/** Map thrown errors to appropriate HTTP responses. */
export function handleError(error: unknown): NextResponse {
  if (error instanceof ProjectNotFoundError) {
    return errorResponse(404, error.message);
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return errorResponse(500, message);
}
