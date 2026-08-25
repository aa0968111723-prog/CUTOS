import { describe, expect, it } from "vitest";
import { createPlanner, createVisionProvider, describeProvider, readZeaburConfig } from "./factory.js";

describe("Zeabur AI Hub provider", () => {
  it("reads config without exposing the API key", () => {
    const env = {
      CUTOS_AI_PROVIDER: "zeabur",
      CUTOS_ZEABUR_AI_API_KEY: "sk-test-secret",
      CUTOS_ZEABUR_AI_BASE_URL: "https://example.invalid/v1",
      CUTOS_ZEABUR_VISION_MODEL: "gpt-4o-mini",
      CUTOS_ZEABUR_REASONING_MODEL: "gpt-4o",
      CUTOS_ZEABUR_FAST_MODEL: "gpt-4o-mini",
    };
    const config = readZeaburConfig(env);
    expect(config.configured).toBe(true);
    expect(config.baseUrl).toBe("https://example.invalid/v1");
    expect(JSON.stringify(config)).not.toContain("sk-test-secret");
    const info = describeProvider(env);
    expect(info.provider).toBe("zeabur");
    expect(info.visionConfigured).toBe(true);
    expect(JSON.stringify(info)).not.toContain("sk-test-secret");
  });

  it("defaults the base URL without hard-binding a required endpoint", () => {
    const config = readZeaburConfig({ CUTOS_ZEABUR_AI_API_KEY: "x" });
    expect(config.baseUrl).toBe("https://hnd1.aihub.zeabur.ai/v1");
    const custom = readZeaburConfig({
      CUTOS_ZEABUR_AI_API_KEY: "x",
      CUTOS_ZEABUR_AI_BASE_URL: "https://sfo1.aihub.zeabur.ai/v1/",
    });
    expect(custom.baseUrl).toBe("https://sfo1.aihub.zeabur.ai/v1");
  });

  it("falls back to the local planner when Zeabur is requested without a key", () => {
    const planner = createPlanner({ CUTOS_AI_PROVIDER: "zeabur" });
    expect(planner.name).toBe("local-heuristic");
    expect(createVisionProvider({ CUTOS_AI_PROVIDER: "zeabur" }).configured).toBe(false);
  });

  it("does not break OpenAI / AIOS / local selection", () => {
    expect(createPlanner({}).name).toBe("local-heuristic");
    expect(createPlanner({ CUTOS_LLM_PROVIDER: "openai" }).name).toBe("local-heuristic");
    expect(describeProvider({ CUTOS_LLM_PROVIDER: "aios" }).provider).toBe("aios");
  });
});
