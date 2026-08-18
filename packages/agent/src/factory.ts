import { LocalHeuristicPlanner } from "./local-planner.js";
import { OpenAICompatiblePlanner } from "./openai-planner.js";
import type { Planner } from "./types.js";

/**
 * Select a planner from environment configuration. Defaults to the offline
 * deterministic planner so CUTOS runs with zero external dependencies; an
 * OpenAI-compatible endpoint is used only when explicitly configured. This is
 * the model-agnostic seam: swapping providers never touches domain code.
 */
export function createPlanner(env: NodeJS.ProcessEnv = process.env): Planner {
  const provider = (env.CUTOS_LLM_PROVIDER ?? "local").toLowerCase();

  if (provider === "openai" || provider === "openai-compatible") {
    const apiKey = env.CUTOS_OPENAI_API_KEY;
    const baseUrl = env.CUTOS_OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    const model = env.CUTOS_OPENAI_MODEL ?? "gpt-4o-mini";
    if (apiKey) {
      return new OpenAICompatiblePlanner({ apiKey, baseUrl, model });
    }
    // Fall back to deterministic planning when no key is configured.
  }

  return new LocalHeuristicPlanner();
}
