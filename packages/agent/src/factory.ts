import { LocalHeuristicPlanner } from "./local-planner.js";
import { OpenAICompatiblePlanner } from "./openai-planner.js";
import { AiosPlanner } from "./aios-planner.js";
import type { Planner } from "./types.js";

export interface AiosConfig {
  configured: boolean;
  kernelUrl?: string;
  queryPath: string;
  healthPath: string;
  model: string;
  backend: string;
  agentName: string;
}

/** Read AIOS kernel configuration from the environment. */
export function readAiosConfig(env: NodeJS.ProcessEnv = process.env): AiosConfig {
  const kernelUrl = env.CUTOS_AIOS_KERNEL_URL;
  return {
    configured: Boolean(kernelUrl),
    kernelUrl,
    queryPath: env.CUTOS_AIOS_QUERY_PATH ?? "/query",
    healthPath: env.CUTOS_AIOS_HEALTH_PATH ?? "/health",
    model: env.CUTOS_AIOS_MODEL ?? "gpt-4o-mini",
    backend: env.CUTOS_AIOS_BACKEND ?? "openai",
    agentName: env.CUTOS_AIOS_AGENT_NAME ?? "cutos",
  };
}

/**
 * Select a planner from environment configuration. Defaults to the offline
 * deterministic planner so CUTOS runs with zero external dependencies. An AIOS
 * kernel or an OpenAI-compatible endpoint is used only when explicitly
 * configured. This is the model-agnostic seam: swapping providers never touches
 * domain code.
 */
export function createPlanner(env: NodeJS.ProcessEnv = process.env): Planner {
  const provider = (env.CUTOS_LLM_PROVIDER ?? "local").toLowerCase();

  if (provider === "aios") {
    const aios = readAiosConfig(env);
    if (aios.configured && aios.kernelUrl) {
      return new AiosPlanner({
        kernelUrl: aios.kernelUrl,
        queryPath: aios.queryPath,
        model: aios.model,
        backend: aios.backend,
        agentName: aios.agentName,
        apiKey: env.CUTOS_AIOS_API_KEY,
      });
    }
    // Kernel not configured → fall back to deterministic planning.
  }

  if (provider === "openai" || provider === "openai-compatible") {
    const apiKey = env.CUTOS_OPENAI_API_KEY;
    const baseUrl = env.CUTOS_OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    const model = env.CUTOS_OPENAI_MODEL ?? "gpt-4o-mini";
    if (apiKey) {
      return new OpenAICompatiblePlanner({ apiKey, baseUrl, model });
    }
  }

  return new LocalHeuristicPlanner();
}

export interface ProviderInfo {
  provider: "local" | "openai" | "aios";
  /** The active planner's name (e.g. "local-heuristic", "aios:gpt-4o-mini@openai"). */
  name: string;
  aios: AiosConfig;
}

/** Describe the active provider + AIOS connection for the UI/status surfaces. */
export function describeProvider(env: NodeJS.ProcessEnv = process.env): ProviderInfo {
  const requested = (env.CUTOS_LLM_PROVIDER ?? "local").toLowerCase();
  const provider: ProviderInfo["provider"] =
    requested === "aios" ? "aios" : requested === "openai" || requested === "openai-compatible" ? "openai" : "local";
  return {
    provider,
    name: createPlanner(env).name,
    aios: readAiosConfig(env),
  };
}
