import {
  CUTOS_PROTOCOL_VERSION,
  CUTOS_SUPPORTED_PROTOCOLS,
  aiosRunStateSchema,
  checkProtocolCompatibility,
  type AiosRunRequest,
  type AiosRunState,
  type CutosErrorCode,
  type QualityProfile,
} from "@cutos/protocol";

/**
 * CUTOS → AIOS orchestration adapter.
 *
 * CUTOS asks AIOS to run a goal and then tracks it; it does NOT reach into AIOS
 * internals. Everything crosses a documented HTTP contract whose responses are
 * Zod-validated before they can influence CUTOS state, so a malformed or
 * hostile AIOS response cannot smuggle an unvalidated Edit Plan into the
 * timeline.
 *
 * Vendor neutrality is structural: a request states a `capability` and a
 * `qualityProfile` (fast / balanced / quality / local). Which model or backend
 * serves it is entirely an AIOS decision — no vendor name appears here.
 */

export class AiosOrchestratorError extends Error {
  constructor(
    readonly code: CutosErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AiosOrchestratorError";
  }
}

export interface AiosOrchestratorOptions {
  /** AIOS base URL, e.g. http://localhost:3000 */
  baseUrl: string;
  /** Bearer token when the AIOS deployment is protected. */
  apiKey?: string;
  timeoutMs?: number;
  /** Attempts for transient transport failures (network/5xx/timeouts). */
  maxAttempts?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Paths are configurable so CUTOS is not pinned to one AIOS routing scheme. */
  paths?: Partial<OrchestratorPaths>;
}

export interface OrchestratorPaths {
  submit: string;
  get: string;
  cancel: string;
  resume: string;
  health: string;
}

const DEFAULT_PATHS: OrchestratorPaths = {
  submit: "/api/cutos/runs",
  get: "/api/cutos/runs/:runId",
  cancel: "/api/cutos/runs/:runId/cancel",
  resume: "/api/cutos/runs/:runId/resume",
  health: "/api/cutos/health",
};

export interface AiosRunHandle {
  aiosRunId: string;
  status: AiosRunState["status"];
  state: AiosRunState;
}

export interface AiosOrchestratorHealth {
  reachable: boolean;
  protocolVersion?: string;
  supportedProtocols?: string[];
  compatible: boolean;
  /** Stable zh-TW key; a raw exception is never surfaced to a user. */
  messageKey: string;
  latencyMs?: number;
}

/** The contract CUTOS depends on. Implemented by {@link HttpAiosOrchestrator}. */
export interface AiosOrchestrator {
  health(): Promise<AiosOrchestratorHealth>;
  submitRun(input: AiosRunRequest, signal?: AbortSignal): Promise<AiosRunHandle>;
  getRun(runId: string, signal?: AbortSignal): Promise<AiosRunState>;
  cancelRun(runId: string, signal?: AbortSignal): Promise<AiosRunState>;
  resumeRun(runId: string, signal?: AbortSignal): Promise<AiosRunState>;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HttpAiosOrchestrator implements AiosOrchestrator {
  private readonly baseUrl: string;
  private readonly paths: OrchestratorPaths;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly now: () => number;

  constructor(private readonly options: AiosOrchestratorOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.paths = { ...DEFAULT_PATHS, ...options.paths };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.now = options.now ?? (() => Date.now());
  }

  private url(path: string, runId?: string): string {
    const resolved = runId ? path.replace(":runId", encodeURIComponent(runId)) : path;
    return `${this.baseUrl}${resolved.startsWith("/") ? resolved : `/${resolved}`}`;
  }

  private async request(
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let lastError: AiosOrchestratorError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const headers = new Headers(init.headers);
        headers.set("accept", "application/json");
        headers.set("x-cutos-protocol", CUTOS_PROTOCOL_VERSION);
        if (init.body) headers.set("content-type", "application/json");
        if (this.options.apiKey) headers.set("authorization", `Bearer ${this.options.apiKey}`);

        const response = await this.fetchImpl(url, { ...init, headers, signal: controller.signal });
        const text = await response.text();
        const payload = text ? safeJson(text) : {};
        if (response.ok) return payload;

        const error = new AiosOrchestratorError(
          statusToCode(response.status),
          sanitizeMessage(payload, response.status),
          response.status,
        );
        // A 4xx (other than the transient ones) is the caller's problem: no retry.
        if (!RETRYABLE_STATUS.has(response.status) || attempt === this.maxAttempts) throw error;
        lastError = error;
      } catch (error) {
        if (error instanceof AiosOrchestratorError) {
          if (attempt === this.maxAttempts) throw error;
          lastError = error;
        } else if (signal?.aborted) {
          throw new AiosOrchestratorError("CANCELLED", "AIOS request cancelled by the caller");
        } else if (isAbort(error)) {
          const timeoutError = new AiosOrchestratorError("TIMEOUT", "AIOS request timed out");
          if (attempt === this.maxAttempts) throw timeoutError;
          lastError = timeoutError;
        } else {
          const unavailable = new AiosOrchestratorError(
            "UNAVAILABLE",
            "AIOS is unreachable",
          );
          if (attempt === this.maxAttempts) throw unavailable;
          lastError = unavailable;
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
      await delay(this.retryDelayMs * 2 ** (attempt - 1));
    }
    throw lastError ?? new AiosOrchestratorError("INTERNAL", "AIOS request failed");
  }

  async health(): Promise<AiosOrchestratorHealth> {
    const started = this.now();
    try {
      const payload = (await this.request(this.url(this.paths.health), { method: "GET" })) as {
        protocolVersion?: string;
        supportedProtocols?: string[];
      };
      const compatibility = checkProtocolCompatibility(
        payload.protocolVersion,
        payload.supportedProtocols,
        CUTOS_SUPPORTED_PROTOCOLS,
      );
      return {
        reachable: true,
        ...(payload.protocolVersion ? { protocolVersion: payload.protocolVersion } : {}),
        ...(payload.supportedProtocols ? { supportedProtocols: payload.supportedProtocols } : {}),
        compatible: compatibility.compatible,
        messageKey: compatibility.compatible
          ? "aios.status.connected"
          : compatibility.messageKey ?? "aios.protocol.mismatch",
        latencyMs: this.now() - started,
      };
    } catch {
      return {
        reachable: false,
        compatible: false,
        messageKey: "aios.status.disconnected",
        latencyMs: this.now() - started,
      };
    }
  }

  async submitRun(input: AiosRunRequest, signal?: AbortSignal): Promise<AiosRunHandle> {
    const payload = await this.request(
      this.url(this.paths.submit),
      { method: "POST", body: JSON.stringify(input) },
      signal,
    );
    const state = this.parseState(payload);
    return { aiosRunId: state.aiosRunId, status: state.status, state };
  }

  async getRun(runId: string, signal?: AbortSignal): Promise<AiosRunState> {
    return this.parseState(
      await this.request(this.url(this.paths.get, runId), { method: "GET" }, signal),
    );
  }

  async cancelRun(runId: string, signal?: AbortSignal): Promise<AiosRunState> {
    return this.parseState(
      await this.request(this.url(this.paths.cancel, runId), { method: "POST", body: "{}" }, signal),
    );
  }

  async resumeRun(runId: string, signal?: AbortSignal): Promise<AiosRunState> {
    return this.parseState(
      await this.request(this.url(this.paths.resume, runId), { method: "POST", body: "{}" }, signal),
    );
  }

  /** Never trust the peer: a malformed run state is a hard, typed failure. */
  private parseState(payload: unknown): AiosRunState {
    const parsed = aiosRunStateSchema.safeParse(payload);
    if (parsed.success) return parsed.data;

    // Distinguish the two failure modes the operator has to act on:
    // a peer that DECLARES a protocol we cannot speak (upgrade one side) vs a
    // peer on our protocol that sent a broken body (a bug on their side).
    const declared = (payload as { protocolVersion?: unknown } | null)?.protocolVersion;
    if (typeof declared === "string") {
      const compatibility = checkProtocolCompatibility(declared, [], CUTOS_SUPPORTED_PROTOCOLS);
      if (!compatibility.compatible) {
        throw new AiosOrchestratorError(
          "PROTOCOL_VERSION_MISMATCH",
          `AIOS speaks ${declared}; CUTOS speaks ${CUTOS_SUPPORTED_PROTOCOLS.join(", ")}`,
        );
      }
    }
    throw new AiosOrchestratorError(
      "VALIDATION_FAILED",
      `AIOS returned a malformed run state: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .slice(0, 5)
        .join("; ")}`,
    );
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 500) };
  }
}

/** Peer error text is bounded and never re-thrown as a stack trace. */
function sanitizeMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === "object") {
    const record = payload as { error?: { message?: unknown }; message?: unknown };
    const candidate = record.error?.message ?? record.message;
    if (typeof candidate === "string" && candidate.trim()) return candidate.slice(0, 500);
  }
  return `AIOS request failed with status ${status}`;
}

function statusToCode(status: number): CutosErrorCode {
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN_PROJECT_SCOPE";
  if (status === 404) return "RUN_NOT_FOUND";
  if (status === 409) return "IDEMPOTENCY_CONFLICT";
  if (status === 408 || status === 504) return "TIMEOUT";
  if (status === 422 || status === 400) return "VALIDATION_FAILED";
  if (status >= 500) return "UNAVAILABLE";
  return "INTERNAL";
}

export interface AiosOrchestratorConfig {
  configured: boolean;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs: number;
  qualityProfile: QualityProfile;
}

export function readOrchestratorConfig(
  env: NodeJS.ProcessEnv = process.env,
): AiosOrchestratorConfig {
  const baseUrl = env.CUTOS_AIOS_URL?.trim();
  const timeout = Number(env.CUTOS_AIOS_TIMEOUT_MS ?? "30000");
  const profile = (env.CUTOS_AIOS_QUALITY ?? "balanced").toLowerCase();
  const qualityProfile: QualityProfile =
    profile === "fast" || profile === "quality" || profile === "local" ? profile : "balanced";
  return {
    configured: Boolean(baseUrl),
    ...(baseUrl ? { baseUrl } : {}),
    ...(env.CUTOS_AIOS_ORCH_KEY?.trim() ? { apiKey: env.CUTOS_AIOS_ORCH_KEY.trim() } : {}),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 30_000,
    qualityProfile,
  };
}

export function createAiosOrchestrator(
  env: NodeJS.ProcessEnv = process.env,
): AiosOrchestrator | null {
  const config = readOrchestratorConfig(env);
  if (!config.configured || !config.baseUrl) return null;
  return new HttpAiosOrchestrator({
    baseUrl: config.baseUrl,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    timeoutMs: config.timeoutMs,
  });
}
