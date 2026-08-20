import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CUTOS_PROTOCOL_VERSION, PROTOCOL_CONTRACT, PROTOCOL_CONTRACT_FINGERPRINT } from "@cutos/protocol";
import { AiosOrchestratorError, HttpAiosOrchestrator } from "./aios-orchestrator.js";

/**
 * CROSS-REPOSITORY CONTRACT TEST — the CUTOS → AIOS direction.
 *
 * The mirror of what ai_os already does with CUTOS's recordings. This file is
 * not hand-written JSON: it is the literal HTTP traffic ai_os's own test
 * (`server/services/cutosInboundRuns.pg.test.ts`) recorded from its production
 * Express handlers running against real PostgreSQL.
 *
 * Why it exists: CUTOS shipped `HttpAiosOrchestrator` pointed at `/api/cutos/*`
 * while ai_os served none of those routes, and every suite in both repos stayed
 * green — the client had only ever been tested against a server written inside
 * its own test file, which is a mirror, not a contract. Replaying the real
 * peer's bytes is what makes this direction real.
 *
 * Regenerate after an intentional AIOS change:
 *   (ai_os) RUN_PG_INTEGRATION=1 npx vitest run server/services/cutosInboundRuns.pg.test.ts
 *   (CUTOS) cp ai_os/docs/contract/aios.cutos.v2.inbound.fixtures.json docs/contract/
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, "../../../docs/contract/aios.cutos.v2.inbound.fixtures.json");

interface Exchange {
  scenario: string;
  request: { method: string; path: string; body?: unknown };
  response: { status: number; body: unknown };
}

interface InboundFixtureFile {
  protocolVersion: string;
  contractFingerprint: string;
  generator: string;
  exchanges: Exchange[];
}

const FIXTURES = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as InboundFixtureFile;

function scenario(name: string): Exchange {
  const found = FIXTURES.exchanges.find((exchange) => exchange.scenario === name);
  if (!found) throw new Error(`inbound fixture scenario "${name}" is missing; regenerate from ai_os`);
  return found;
}

describe("cross-repo contract: AIOS recordings replayed through the real orchestrator client", () => {
  let server: Server;
  let baseUrl = "";
  /** The scenario the next request should be answered from. */
  let serving: Exchange | null = null;
  let lastRequest: { method: string; path: string; headers: Record<string, string>; body: unknown } | null = null;

  beforeAll(async () => {
    server = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8");
        lastRequest = {
          method: req.method ?? "GET",
          path: req.url ?? "/",
          headers: Object.fromEntries(
            Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v ?? "")]),
          ),
          body: raw ? (JSON.parse(raw) as unknown) : undefined,
        };
        const exchange = serving;
        if (!exchange) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "INTERNAL", message: "no scenario armed" } }));
          return;
        }
        res.writeHead(exchange.response.status, { "content-type": "application/json" });
        res.end(JSON.stringify(exchange.response.body));
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const client = () => new HttpAiosOrchestrator({
    baseUrl,
    apiKey: "test-key",
    timeoutMs: 5_000,
    maxAttempts: 1,
  });

  function arm(name: string): Exchange {
    const exchange = scenario(name);
    serving = exchange;
    return exchange;
  }

  it("the fixture was recorded against the protocol this build speaks", () => {
    expect(FIXTURES.generator).toBe("aios");
    expect(FIXTURES.protocolVersion).toBe(CUTOS_PROTOCOL_VERSION);
    expect(FIXTURES.contractFingerprint).toBe(PROTOCOL_CONTRACT_FINGERPRINT);
  });

  it("covers every AIOS endpoint the contract requires", () => {
    // Not a vacuous loop: the contract names five endpoints.
    const paths = new Set(FIXTURES.exchanges.map((exchange) => exchange.request.path.replace(/\/[0-9a-f-]{36}/g, "/:runId")));
    expect(Object.keys(PROTOCOL_CONTRACT.aiosEndpoints)).toHaveLength(5);
    expect(paths.has("/api/cutos/health")).toBe(true);
    expect(paths.has("/api/cutos/runs")).toBe(true);
    expect([...paths].some((path) => /^\/api\/cutos\/runs\/:runId$/.test(path))).toBe(true);
    expect([...paths].some((path) => path.endsWith("/cancel"))).toBe(true);
    expect([...paths].some((path) => path.endsWith("/resume"))).toBe(true);
  });

  it("reads AIOS health and negotiates a compatible protocol", async () => {
    arm("health");
    const health = await client().health();
    expect(health.reachable).toBe(true);
    expect(health.compatible).toBe(true);
    expect(health.protocolVersion).toBe(CUTOS_PROTOCOL_VERSION);
    expect(health.messageKey).toBe("aios.status.connected");
  });

  it("parses a real submitted run, including the correlation AIOS echoed back", async () => {
    const exchange = arm("submit_run");
    const request = exchange.request.body as {
      goal: string;
      capability: string;
      qualityProfile: string;
      correlation: Record<string, unknown>;
    };
    const handle = await client().submitRun({
      protocolVersion: CUTOS_PROTOCOL_VERSION,
      goal: request.goal,
      capability: request.capability,
      qualityProfile: request.qualityProfile as "balanced",
      correlation: request.correlation as never,
    });

    // The state validated through the real Zod schema, not a hand-built object.
    expect(handle.aiosRunId).toBe((exchange.response.body as { aiosRunId: string }).aiosRunId);
    expect(handle.status).toBe("waiting_approval");
    expect(handle.state.steps.length).toBeGreaterThan(5);
    // The traceability chain survives the round trip.
    expect(handle.state.correlation.cutosAgentRunId).toBe(request.correlation.cutosAgentRunId);
    expect(handle.state.correlation.idempotencyKey).toBe(request.correlation.idempotencyKey);
    expect(handle.state.correlation.cutosProjectId).toBe(request.correlation.cutosProjectId);

    // The credential travels in a header, never in the body or the path.
    expect(lastRequest?.headers.authorization).toBe("Bearer test-key");
    expect(lastRequest?.headers["x-cutos-protocol"]).toBe(CUTOS_PROTOCOL_VERSION);
    expect(JSON.stringify(lastRequest?.body)).not.toContain("test-key");
  });

  it("treats a replayed submit as the same run, not a new one", async () => {
    const first = arm("submit_run").response.body as { aiosRunId: string };
    const replay = arm("submit_idempotent_replay").response.body as { aiosRunId: string };
    expect(replay.aiosRunId).toBe(first.aiosRunId);

    const request = scenario("submit_idempotent_replay").request.body as { correlation: Record<string, unknown> };
    const handle = await client().submitRun({
      protocolVersion: CUTOS_PROTOCOL_VERSION,
      goal: "retry",
      capability: "video.highlight.package",
      qualityProfile: "balanced",
      correlation: request.correlation as never,
    });
    expect(handle.aiosRunId).toBe(first.aiosRunId);
  });

  it("polls a run", async () => {
    const exchange = arm("get_run");
    const state = await client().getRun((exchange.response.body as { aiosRunId: string }).aiosRunId);
    expect(state.protocolVersion).toBe(CUTOS_PROTOCOL_VERSION);
    expect(state.correlation.aiosRunId).toBe(state.aiosRunId);
  });

  it("cancels a run and reports it cancelled", async () => {
    const exchange = arm("cancel_run");
    const state = await client().cancelRun((exchange.response.body as { aiosRunId: string }).aiosRunId);
    expect(state.status).toBe("cancelled");
  });

  it("reports a repeated cancel as the same terminal state, not an error", async () => {
    const exchange = arm("cancel_run_repeat");
    const state = await client().cancelRun((exchange.response.body as { aiosRunId: string }).aiosRunId);
    expect(state.status).toBe("cancelled");
  });

  it("surfaces the approval gate as APPROVAL_REQUIRED, not INTERNAL", async () => {
    // The regression this pins: the client used to derive its code from the
    // HTTP status alone, so AIOS's 428 became INTERNAL and the operator could
    // not tell that a human simply had to approve.
    arm("resume_requires_approval");
    const error = await client().resumeRun("00000000-0000-4000-8000-000000000001")
      .then(() => null, (caught: unknown) => caught) as AiosOrchestratorError;
    expect(error).toBeInstanceOf(AiosOrchestratorError);
    expect(error.code).toBe("APPROVAL_REQUIRED");
    expect(error.messageKey).toBe("aios.error.approvalRequired");
  });

  it("distinguishes a protocol mismatch from an idempotency conflict on the same 409", async () => {
    // Both are 409. Only the body tells them apart, which is why the code is
    // read from the body rather than guessed from the status.
    arm("protocol_mismatch");
    const error = await client().submitRun({
      protocolVersion: CUTOS_PROTOCOL_VERSION,
      goal: "x",
      capability: "video.edit.plan",
      qualityProfile: "balanced",
      correlation: { requestId: "r1", idempotencyKey: "k1", cutosProjectId: "p1" },
    }).then(() => null, (caught: unknown) => caught) as AiosOrchestratorError;
    expect(error.code).toBe("PROTOCOL_VERSION_MISMATCH");
    expect(error.status).toBe(409);
  });

  it("reports a missing credential as UNAUTHORIZED", async () => {
    arm("unauthorized");
    const error = await client().getRun("00000000-0000-4000-8000-000000000001")
      .then(() => null, (caught: unknown) => caught) as AiosOrchestratorError;
    expect(error.code).toBe("UNAUTHORIZED");
  });

  it("reports an unsupported capability without inventing a retry", async () => {
    arm("unsupported_capability");
    const error = await client().submitRun({
      protocolVersion: CUTOS_PROTOCOL_VERSION,
      goal: "x",
      capability: "video.delete.everything",
      qualityProfile: "balanced",
      correlation: { requestId: "r2", idempotencyKey: "k2", cutosProjectId: "p1" },
    }).then(() => null, (caught: unknown) => caught) as AiosOrchestratorError;
    expect(error.code).toBe("UNSUPPORTED_OPERATION");
  });

  it("cannot tell an unbound project from another group's project", async () => {
    // Both scenarios must look identical on the wire, or CUTOS becomes an
    // oracle for which project ids exist in someone else's group.
    const unbound = scenario("unbound_project").response;
    const crossGroup = scenario("cross_group_denied").response;
    expect(unbound.status).toBe(crossGroup.status);
    expect((unbound.body as { error: { code: string } }).error.code)
      .toBe((crossGroup.body as { error: { code: string } }).error.code);
  });

  it("never receives a stack trace or a credential from AIOS", () => {
    const dump = JSON.stringify(FIXTURES.exchanges);
    expect(dump).not.toMatch(/node_modules|\.ts:\d+:\d+|at \w+ \(/);
    expect(dump).not.toMatch(/aidmcp_/);
  });
});
