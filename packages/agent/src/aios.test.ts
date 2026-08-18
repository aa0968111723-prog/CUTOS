import { describe, expect, it, vi } from "vitest";
import { AiosPlanner } from "./aios-planner.js";
import { createPlanner, describeProvider, readAiosConfig } from "./factory.js";
import type { PlanRequest } from "./types.js";

const request: PlanRequest = {
  instruction: "刪掉超過 1 秒的停頓",
  sourceDurationMs: 12_000,
  silences: [
    { startMs: 1500, endMs: 3000 },
    { startMs: 4500, endMs: 6000 },
  ],
};

function fakeFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok,
    status,
    statusText: ok ? "OK" : "ERR",
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe("AiosPlanner", () => {
  it("posts an LLMQuery to the kernel and parses the LLMResponse", async () => {
    const fetchImpl = fakeFetch({
      response_message: JSON.stringify({
        summary: "刪除 2 個停頓。",
        operations: [
          { type: "removeRange", startMs: 1500, endMs: 3000 },
          { type: "removeRange", startMs: 4500, endMs: 6000 },
        ],
      }),
      finished: true,
      error: null,
      status_code: 200,
    });

    const planner = new AiosPlanner({
      kernelUrl: "http://localhost:8000",
      model: "gpt-4o-mini",
      backend: "openai",
      fetchImpl,
    });
    expect(planner.name).toBe("aios:gpt-4o-mini@openai");

    const proposed = await planner.propose(request);
    expect(proposed.operations).toHaveLength(2);
    expect(proposed.summary).toContain("刪除");

    // Verify the request targeted the kernel query endpoint with an LLMQuery.
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(call[0]).toBe("http://localhost:8000/query");
    const sent = JSON.parse((call[1] as { body: string }).body) as {
      query: { llms: { name: string; backend: string }[]; action_type: string; message_return_type: string };
    };
    expect(sent.query.llms[0]).toEqual({ name: "gpt-4o-mini", backend: "openai" });
    expect(sent.query.action_type).toBe("chat");
    expect(sent.query.message_return_type).toBe("json");
  });

  it("throws on a kernel error field", async () => {
    const planner = new AiosPlanner({
      kernelUrl: "http://localhost:8000",
      model: "m",
      backend: "openai",
      fetchImpl: fakeFetch({ error: "no model", status_code: 500 }),
    });
    await expect(planner.propose(request)).rejects.toThrow(/AIOS kernel error/);
  });

  it("throws on a non-OK HTTP status", async () => {
    const planner = new AiosPlanner({
      kernelUrl: "http://localhost:8000",
      model: "m",
      backend: "openai",
      fetchImpl: fakeFetch({}, false, 502),
    });
    await expect(planner.propose(request)).rejects.toThrow(/request failed/);
  });

  it("honors a custom query path", async () => {
    const fetchImpl = fakeFetch({ response_message: JSON.stringify({ summary: "s", operations: [] }) });
    const planner = new AiosPlanner({
      kernelUrl: "http://localhost:8000/",
      queryPath: "core/llm",
      model: "m",
      backend: "ollama",
      fetchImpl,
    });
    await planner.propose(request);
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(call[0]).toBe("http://localhost:8000/core/llm");
  });
});

describe("createPlanner / describeProvider (AIOS)", () => {
  it("selects AiosPlanner when provider=aios and a kernel URL is set", () => {
    const env = {
      CUTOS_LLM_PROVIDER: "aios",
      CUTOS_AIOS_KERNEL_URL: "http://localhost:8000",
      CUTOS_AIOS_MODEL: "qwen2.5:7b",
      CUTOS_AIOS_BACKEND: "ollama",
    } as unknown as NodeJS.ProcessEnv;
    const planner = createPlanner(env);
    expect(planner.name).toBe("aios:qwen2.5:7b@ollama");
    const info = describeProvider(env);
    expect(info.provider).toBe("aios");
    expect(info.aios.configured).toBe(true);
    expect(info.aios.kernelUrl).toBe("http://localhost:8000");
  });

  it("falls back to the deterministic planner when the kernel is not configured", () => {
    const env = { CUTOS_LLM_PROVIDER: "aios" } as unknown as NodeJS.ProcessEnv;
    expect(createPlanner(env).name).toBe("local-heuristic");
    expect(readAiosConfig(env).configured).toBe(false);
    expect(describeProvider(env).provider).toBe("aios");
  });

  it("defaults to local with no env", () => {
    const info = describeProvider({} as NodeJS.ProcessEnv);
    expect(info.provider).toBe("local");
    expect(info.name).toBe("local-heuristic");
  });
});
