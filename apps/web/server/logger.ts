export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  requestId?: string;
  jobId?: string;
  agentRunId?: string;
  projectId?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  child(context: LogContext): Logger;
}

/**
 * Minimal structured logger. Emits one JSON object per line with a shared
 * context (requestId/jobId/agentRunId/projectId) so logs are traceable across
 * the request → job → agent-run boundaries.
 */
function make(context: LogContext): Logger {
  const emit = (level: LogLevel, msg: string, extra?: Record<string, unknown>) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...context, ...extra });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };
  return {
    debug: (m, e) => emit("debug", m, e),
    info: (m, e) => emit("info", m, e),
    warn: (m, e) => emit("warn", m, e),
    error: (m, e) => emit("error", m, e),
    child: (extra) => make({ ...context, ...extra }),
  };
}

export const logger: Logger = make({ service: "cutos-web" });
