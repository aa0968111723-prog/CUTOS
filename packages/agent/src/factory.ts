import { LocalHeuristicPlanner } from "./local-planner.js";
import { OpenAICompatiblePlanner } from "./openai-planner.js";
import { AiosPlanner } from "./aios-planner.js";
import type { Planner } from "./types.js";
import type { ModelCatalog } from "./model-router.js";
import type { ModelUsageSink } from "./model-router.js";
import { OpenAICompatibleVisionProvider } from "./vision-provider.js";
import { UnavailableVisionProvider, type VideoVisionProvider } from "./vision.js";

export interface AiosConfig {
  configured: boolean;
  kernelUrl?: string;
  queryPath: string;
  healthPath: string;
  model: string;
  backend: string;
  agentName: string;
}

export type ProviderKind = "local" | "openai" | "aios" | "zeabur";

const DEFAULT_ZEABUR_BASE_URL = "https://hnd1.aihub.zeabur.ai/v1";

export interface ZeaburConfig {
  /** True when an API key is present. The key itself is never stored here. */
  configured: boolean;
  baseUrl: string;
  visionModel: string;
  reasoningModel: string;
  fastModel: string;
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

/** Read Zeabur AI Hub configuration. The API key is never returned. */
export function readZeaburConfig(env: NodeJS.ProcessEnv = process.env): ZeaburConfig {
  const rawUrl = env.CUTOS_ZEABUR_AI_BASE_URL?.trim();
  return {
    configured: Boolean(env.CUTOS_ZEABUR_AI_API_KEY),
    baseUrl: rawUrl && rawUrl.length > 0 ? rawUrl.replace(/\/$/, "") : DEFAULT_ZEABUR_BASE_URL,
    visionModel: env.CUTOS_ZEABUR_VISION_MODEL ?? "gpt-4o-mini",
    reasoningModel: env.CUTOS_ZEABUR_REASONING_MODEL ?? "gpt-4o",
    fastModel: env.CUTOS_ZEABUR_FAST_MODEL ?? "gpt-4o-mini",
  };
}

/**
 * CUTOS_AI_PROVIDER takes precedence over the older CUTOS_LLM_PROVIDER so
 * existing OpenAI / AIOS / local deployments keep working.
 */
export function requestedProvider(env: NodeJS.ProcessEnv = process.env): ProviderKind {
  const raw = (env.CUTOS_AI_PROVIDER ?? env.CUTOS_LLM_PROVIDER ?? "local").toLowerCase();
  if (raw === "zeabur") return "zeabur";
  if (raw === "aios") return "aios";
  if (raw === "openai" || raw === "openai-compatible") return "openai";
  return "local";
}

export function zeaburCatalog(env: NodeJS.ProcessEnv = process.env): ModelCatalog {
  const z = readZeaburConfig(env);
  return {
    provider: "zeabur",
    fastModel: z.fastModel,
    visionModel: z.visionModel,
    reasoningModel: z.reasoningModel,
  };
}

/**
 * Select a planner from environment configuration. Defaults to the offline
 * deterministic planner so CUTOS runs with zero external dependencies. An AIOS
 * kernel, Zeabur AI Hub, or an OpenAI-compatible endpoint is used only when
 * explicitly configured. This is the model-agnostic seam: swapping providers
 * never touches domain code.
 */
export function createPlanner(env: NodeJS.ProcessEnv = process.env): Planner {
  const provider = requestedProvider(env);

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
  }

  if (provider === "zeabur") {
    const zeabur = readZeaburConfig(env);
    const apiKey = env.CUTOS_ZEABUR_AI_API_KEY;
    if (apiKey) {
      return new OpenAICompatiblePlanner({
        apiKey,
        baseUrl: zeabur.baseUrl,
        model: zeabur.reasoningModel,
        name: `zeabur:${zeabur.reasoningModel}`,
      });
    }
  }

  if (provider === "openai") {
    const apiKey = env.CUTOS_OPENAI_API_KEY;
    const baseUrl = env.CUTOS_OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    const model = env.CUTOS_OPENAI_MODEL ?? "gpt-4o-mini";
    if (apiKey) {
      return new OpenAICompatiblePlanner({ apiKey, baseUrl, model });
    }
  }

  return new LocalHeuristicPlanner();
}

export function createVisionProvider(
  env: NodeJS.ProcessEnv = process.env,
  onUsage?: ModelUsageSink,
): VideoVisionProvider {
  const provider = requestedProvider(env);

  if (provider === "zeabur") {
    const zeabur = readZeaburConfig(env);
    const apiKey = env.CUTOS_ZEABUR_AI_API_KEY;
    if (apiKey) {
      return new OpenAICompatibleVisionProvider({
        provider: "zeabur",
        baseUrl: zeabur.baseUrl,
        apiKey,
        catalog: zeaburCatalog(env),
        onUsage,
      });
    }
  }

  if (provider === "openai") {
    const apiKey = env.CUTOS_OPENAI_API_KEY;
    const baseUrl = env.CUTOS_OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    const model = env.CUTOS_OPENAI_MODEL ?? "gpt-4o-mini";
    if (apiKey) {
      return new OpenAICompatibleVisionProvider({
        provider: "openai",
        baseUrl,
        apiKey,
        catalog: {
          provider: "openai",
          fastModel: model,
          visionModel: model,
          reasoningModel: model,
        },
        onUsage,
      });
    }
  }

  return new UnavailableVisionProvider();
}

export interface ProviderInfo {
  provider: ProviderKind;
  /** The active planner's name (e.g. "local-heuristic", "zeabur:gpt-4o"). */
  name: string;
  aios: AiosConfig;
  zeabur: ZeaburConfig;
  visionConfigured: boolean;
}

/** Describe the active provider + AIOS / Zeabur connection for the UI/status surfaces. */
export function describeProvider(env: NodeJS.ProcessEnv = process.env): ProviderInfo {
  const provider = requestedProvider(env);
  const zeabur = readZeaburConfig(env);
  return {
    provider,
    name: createPlanner(env).name,
    aios: readAiosConfig(env),
    zeabur,
    visionConfigured: createVisionProvider(env).configured,
  };
}
