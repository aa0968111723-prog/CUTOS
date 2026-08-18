import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AiosPlanner } from "./aios-planner.js";
import { checkAiosConnection } from "./aios-health.js";
import { PlanGateway } from "./gateway.js";
import type { PlanRequest } from "./types.js";

/**
 * End-to-end test of the AIOS INBOUND protocol over real HTTP against a tiny
 * in-test kernel that implements the documented LLM Core contract
 * (LLMQuery → LLMResponse). This proves the adapter's wire format and the
 * gateway validation path without needing an external AIOS deployment.
 */
describe("AIOS inbound integration (real HTTP)", () => {
  let server: Server;
  let baseUrl = "";
  let lastQuery: unknown = null;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        return;
      }
      if (req.method === "POST" && req.url === "/query") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          lastQuery = JSON.parse(body) as unknown;
          const llmResponse = {
            response_message: JSON.stringify({
              summary: "刪除 2 個停頓。",
              operations: [
                { type: "removeRange", startMs: 1500, endMs: 3000, reason: "靜音" },
                { type: "removeRange", startMs: 4500, endMs: 6000, reason: "靜音" },
              ],
            }),
            tool_calls: null,
            finished: true,
            error: null,
            status_code: 200,
          };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(llmResponse));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address && typeof address === "object") baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const request: PlanRequest = {
    instruction: "刪掉超過 1 秒的停頓",
    sourceDurationMs: 12_000,
    silences: [
      { startMs: 1500, endMs: 3000 },
      { startMs: 4500, endMs: 6000 },
    ],
    targetRevision: 0,
  };

  it("proposes edits via a live kernel and the gateway validates them", async () => {
    const planner = new AiosPlanner({ kernelUrl: baseUrl, model: "gpt-4o-mini", backend: "openai" });
    const gateway = new PlanGateway(planner, { now: () => 0, createId: () => "plan_e2e" });

    const result = await gateway.plan(request);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.operations).toHaveLength(2);
      expect(result.value.provider).toBe("aios:gpt-4o-mini@openai");
    }

    // The kernel received a well-formed LLMQuery.
    const sent = lastQuery as { query: { action_type: string; llms: { backend: string }[] } };
    expect(sent.query.action_type).toBe("chat");
    expect(sent.query.llms[0]?.backend).toBe("openai");
  });

  it("reports the live kernel as reachable via the health probe", async () => {
    const status = await checkAiosConnection({ kernelUrl: baseUrl });
    expect(status.reachable).toBe(true);
    expect(status.status).toBe(200);
  });
});
