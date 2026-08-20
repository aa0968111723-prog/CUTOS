import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CUTOS_PROTOCOL_VERSION,
  aiosRunRequestSchema,
  type AiosRunRequest,
  type AiosRunState,
} from "@cutos/protocol";
import { AiosOrchestratorError, HttpAiosOrchestrator } from "./aios-orchestrator.js";

/**
 * CUTOS → AIOS contract, exercised over real HTTP against a stand-in AIOS
 * server. This is the direction where CUTOS is the client, so it covers what
 * CUTOS must survive when the control plane misbehaves: a wrong protocol, a
 * malformed run state, an outage, a hang, and cancel/resume.
 */

type Mode =
  | "ok"
  | "protocol_mismatch"
  | "malformed"
  | "unavailable"
  | "hang"
  | "flaky"
  | "not_found";

describe("AiosOrchestrator over real HTTP", () => {
  let server: Server;
  let baseUrl = "";
  let mode: Mode = "ok";
  let flakyAttempts = 0;
  let lastRequest: AiosRunRequest | undefined;
  const runs = new Map<string, AiosRunState>();

  const state = (id: string, status: AiosRunState["status"]): AiosRunState => ({
    protocolVersion: CUTOS_PROTOCOL_VERSION,
    aiosRunId: id,
    status,
    steps: [
      {
        id: "ensure_transcript",
        kind: "cutos_tool",
        status: status === "completed" ? "done" : "running",
        messageKey: "agent.step.ensureTranscript",
        dependsOn: [],
      },
    ],
    correlation: {
      requestId: "aios-req-1",
      aiosRunId: id,
      createdAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:01.000Z",
    },
    updatedAt: "2026-08-19T00:00:01.000Z",
  });

  beforeAll(async () => {
    server = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };

        if (mode === "hang") return; // never answers
        if (mode === "unavailable") {
          send(503, { error: { message: "AIOS is restarting" } });
          return;
        }
        if (mode === "flaky") {
          flakyAttempts += 1;
          if (flakyAttempts < 3) {
            send(503, { error: { message: "transient" } });
            return;
          }
        }

        if (url.pathname === "/api/cutos/health") {
          if (mode === "protocol_mismatch") {
            send(200, { protocolVersion: "cutos.agent.v9", supportedProtocols: ["cutos.agent.v8"] });
            return;
          }
          send(200, {
            protocolVersion: CUTOS_PROTOCOL_VERSION,
            supportedProtocols: [CUTOS_PROTOCOL_VERSION, "cutos.agent.v1"],
          });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/cutos/runs") {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const parsed = aiosRunRequestSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          if (!parsed.success) {
            send(400, { error: { message: "malformed AiosRunRequest" } });
            return;
          }
          lastRequest = parsed.data;
          if (mode === "malformed") {
            send(200, { aiosRunId: 42, status: "wat" });
            return;
          }
          if (mode === "protocol_mismatch") {
            send(200, { ...state("run-x", "running"), protocolVersion: "cutos.agent.v9" });
            return;
          }
          const id = `aios-run-${runs.size + 1}`;
          runs.set(id, state(id, "running"));
          send(200, runs.get(id));
          return;
        }

        const match = url.pathname.match(/^\/api\/cutos\/runs\/([^/]+)(\/(cancel|resume))?$/);
        if (match) {
          const id = decodeURIComponent(match[1]!);
          const existing = runs.get(id);
          if (!existing || mode === "not_found") {
            send(404, { error: { message: "run not found" } });
            return;
          }
          if (match[3] === "cancel") runs.set(id, state(id, "cancelled"));
          else if (match[3] === "resume") runs.set(id, state(id, "running"));
          send(200, runs.get(id));
          return;
        }

        send(404, { error: { message: "no route" } });
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function orchestrator(overrides: Partial<ConstructorParameters<typeof HttpAiosOrchestrator>[0]> = {}) {
    return new HttpAiosOrchestrator({
      baseUrl,
      timeoutMs: 1_000,
      maxAttempts: 1,
      retryDelayMs: 1,
      ...overrides,
    });
  }

  const request = (): AiosRunRequest => ({
    protocolVersion: CUTOS_PROTOCOL_VERSION,
    goal: "把這支 45 分鐘的訪談剪成一支 8 分鐘精華",
    capability: "video.edit.plan",
    qualityProfile: "balanced",
    correlation: {
      requestId: "cutos-req-1",
      idempotencyKey: "cutos-key-1",
      cutosProjectId: "project-1",
    },
  });

  it("submits a run and gets a validated state back", async () => {
    mode = "ok";
    const handle = await orchestrator().submitRun(request());
    expect(handle.status).toBe("running");
    expect(handle.aiosRunId).toMatch(/^aios-run-/);
    expect(handle.state.steps[0]!.messageKey).toBe("agent.step.ensureTranscript");
  });

  it("sends a provider-neutral request: capability + quality profile, no vendor", async () => {
    mode = "ok";
    await orchestrator().submitRun(request());
    expect(lastRequest?.capability).toBe("video.edit.plan");
    expect(lastRequest?.qualityProfile).toBe("balanced");
    const serialized = JSON.stringify(lastRequest).toLowerCase();
    for (const vendor of ["openai", "anthropic", "gemini", "ollama", "vllm", "gpt-4"]) {
      expect(serialized).not.toContain(vendor);
    }
  });

  it("reads a run back", async () => {
    mode = "ok";
    const handle = await orchestrator().submitRun(request());
    const read = await orchestrator().getRun(handle.aiosRunId);
    expect(read.aiosRunId).toBe(handle.aiosRunId);
  });

  it("cancels a run", async () => {
    mode = "ok";
    const handle = await orchestrator().submitRun(request());
    const cancelled = await orchestrator().cancelRun(handle.aiosRunId);
    expect(cancelled.status).toBe("cancelled");
  });

  it("resumes a run", async () => {
    mode = "ok";
    const handle = await orchestrator().submitRun(request());
    await orchestrator().cancelRun(handle.aiosRunId);
    const resumed = await orchestrator().resumeRun(handle.aiosRunId);
    expect(resumed.status).toBe("running");
  });

  it("detects an incompatible protocol in health without throwing at the user", async () => {
    mode = "protocol_mismatch";
    const health = await orchestrator().health();
    expect(health.reachable).toBe(true);
    expect(health.compatible).toBe(false);
    expect(health.messageKey).toBe("aios.protocol.mismatch");
  });

  it("refuses a run state carrying an incompatible protocol", async () => {
    mode = "protocol_mismatch";
    await expect(orchestrator().submitRun(request())).rejects.toMatchObject({
      code: "PROTOCOL_VERSION_MISMATCH",
    });
  });

  it("refuses a malformed run state instead of trusting the peer", async () => {
    mode = "malformed";
    await expect(orchestrator().submitRun(request())).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it("reports an unavailable AIOS with a typed code, not a raw exception", async () => {
    mode = "unavailable";
    const error = await orchestrator().submitRun(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiosOrchestratorError);
    expect((error as AiosOrchestratorError).code).toBe("UNAVAILABLE");
    expect((error as AiosOrchestratorError).message).not.toContain("at ");
  });

  it("reports health as disconnected when AIOS is down", async () => {
    mode = "unavailable";
    const health = await orchestrator().health();
    expect(health.reachable).toBe(false);
    expect(health.messageKey).toBe("aios.status.disconnected");
  });

  it("times out a hung AIOS", async () => {
    mode = "hang";
    await expect(
      orchestrator({ timeoutMs: 150 }).submitRun(request()),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  }, 20_000);

  it("retries a transient failure and succeeds", async () => {
    mode = "flaky";
    flakyAttempts = 0;
    const handle = await orchestrator({ maxAttempts: 3, retryDelayMs: 5 }).submitRun(request());
    expect(handle.status).toBe("running");
    expect(flakyAttempts).toBe(3);
  }, 20_000);

  it("does not retry a 404 — a missing run is not transient", async () => {
    mode = "ok";
    const handle = await orchestrator().submitRun(request());
    mode = "not_found";
    await expect(
      orchestrator({ maxAttempts: 3, retryDelayMs: 5 }).getRun(handle.aiosRunId),
    ).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
  });

  it("honours an external AbortSignal", async () => {
    mode = "hang";
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(
      orchestrator({ timeoutMs: 5_000 }).submitRun(request(), controller.signal),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  }, 20_000);
});
