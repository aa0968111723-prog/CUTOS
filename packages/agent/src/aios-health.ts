/**
 * Lightweight AIOS kernel connectivity probe. It verifies the kernel is
 * reachable (responds to HTTP) and reports latency, without spending a model
 * call. Any HTTP response — even 404 — means the kernel process is up; only a
 * network/timeout failure counts as unreachable.
 */
export interface AiosConnectionCheckOptions {
  kernelUrl: string;
  healthPath?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface AiosConnectionStatus {
  endpoint: string;
  reachable: boolean;
  status?: number;
  latencyMs?: number;
  error?: string;
}

export async function checkAiosConnection(
  options: AiosConnectionCheckOptions,
): Promise<AiosConnectionStatus> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const healthPath = options.healthPath ?? "/health";
  const base = options.kernelUrl.replace(/\/$/, "");
  const endpoint = `${base}${healthPath.startsWith("/") ? healthPath : `/${healthPath}`}`;
  const timeoutMs = options.timeoutMs ?? 4000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetchImpl(endpoint, { method: "GET", signal: controller.signal });
    return { endpoint, reachable: true, status: res.status, latencyMs: Date.now() - start };
  } catch (error) {
    return {
      endpoint,
      reachable: false,
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
