import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { z } from "zod";
import {
  AgentRuntime,
  ToolRegistry,
  createPlanner,
  PlanGateway,
  EditContextSchema,
  type AgentRun,
  type AgentRunStore,
  type ContextBuilder,
  type EditContext,
  type Tool,
} from "@cutos/agent";
import {
  MemoryJobStore,
  SqliteJobStore,
  WorkerRunner,
  type JobStore,
  type Worker,
} from "@cutos/jobs";
import { LocalStorageAdapter } from "@cutos/storage";
import {
  createMemoryProjectStore,
  createSqliteProjectStore,
  type ProjectStore,
} from "@cutos/project-store";
import {
  exportTimeline,
  runAnalysis,
  type AnalysisSection,
} from "@cutos/media";
import { config } from "./config.js";
import { logger } from "./logger.js";

export interface Runtime {
  store: ProjectStore;
  jobStore: JobStore;
  storage: LocalStorageAdapter;
  runner: WorkerRunner;
  agentRuntime: AgentRuntime;
  agentRunStore: AgentRunStore;
}

interface AnalyzePayload {
  projectId: string;
  sections: AnalysisSection[];
  silenceOptions?: { thresholdDb?: number; minSilenceMs?: number };
}

interface ExportPayload {
  projectId: string;
}

/** AgentRunStore backed by the durable project store. */
class StoreAgentRunStore implements AgentRunStore {
  constructor(private readonly store: ProjectStore) {}
  save(run: AgentRun): void {
    this.store.saveRun({
      id: run.id,
      projectId: run.projectId,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      data: run,
    });
  }
  get(id: string): AgentRun | undefined {
    return this.store.getRun(id)?.data as AgentRun | undefined;
  }
  listByProject(projectId: string): AgentRun[] {
    return this.store.listRuns(projectId).map((r) => r.data as AgentRun);
  }
}

function buildRuntime(): Runtime {
  mkdirSync(config.dataDir, { recursive: true });

  const store =
    config.storeMode === "memory"
      ? createMemoryProjectStore()
      : createSqliteProjectStore(join(config.dataDir, "cutos.db"));
  const jobStore: JobStore =
    config.storeMode === "memory"
      ? new MemoryJobStore()
      : new SqliteJobStore(join(config.dataDir, "jobs.db"));
  const storage = new LocalStorageAdapter(join(config.dataDir, "storage"));
  const agentRunStore = new StoreAgentRunStore(store);

  // --- agent tools ---
  const registry = new ToolRegistry();
  const createEditPlanTool: Tool<{ instruction: string; context: EditContext }, unknown> = {
    name: "create_edit_plan",
    description: "Turn a natural-language instruction into a validated Edit Plan and stage it for review.",
    permission: "plan",
    argsSchema: z.object({ instruction: z.string().min(1), context: EditContextSchema }),
    async execute(args, ctx) {
      const gateway = new PlanGateway(createPlanner());
      const result = await gateway.plan({
        instruction: args.instruction,
        sourceDurationMs: args.context.sourceDurationMs,
        silences: args.context.silences,
        targetRevision: args.context.timelineRevision,
      });
      if (!result.ok) return { issues: result.errors };
      store.savePendingPlan(ctx.projectId, result.value);
      return { plan: result.value };
    },
  };
  registry.register(createEditPlanTool);

  const contextBuilder: ContextBuilder = {
    build: async (projectId) => {
      const project = store.requireProject(projectId);
      const analysis = store.loadAnalysis(projectId);
      const timeline = store.loadTimeline(projectId);
      return {
        sourceDurationMs: project.source.durationMs,
        timelineRevision: timeline?.revision ?? project.timelineRevision,
        silences: analysis?.silences ?? [],
        transcriptSentences: analysis?.transcript?.sentences.map((s) => ({
          startMs: s.startMs,
          endMs: s.endMs,
          text: s.text,
        })),
      };
    },
  };

  const agentRuntime = new AgentRuntime({ registry, contextBuilder, runStore: agentRunStore });

  // --- workers ---
  const analyzeWorker: Worker<AnalyzePayload, { sections: AnalysisSection[] }> = {
    kind: "analyze",
    async handle(payload, ctx) {
      const project = store.requireProject(payload.projectId);
      const asset = store.getAssetByKind(payload.projectId, "original");
      if (!asset) throw new Error("No original media asset for project");
      await ctx.progress({ progress: 0.05, stage: "starting" });
      const existing = store.loadAnalysis(payload.projectId);
      const analysis = await storage.withLocalFile(asset.storageKey, (filePath) =>
        runAnalysis({
          filePath,
          mediaChecksum: asset.checksum,
          existing,
          sections: payload.sections,
          silenceOptions: payload.silenceOptions,
          onSection: (section) => {
            void ctx.progress({ stage: section });
          },
        }),
      );
      store.saveAnalysis(payload.projectId, analysis);
      void project;
      await ctx.progress({ progress: 1, stage: "done" });
      return { sections: payload.sections };
    },
  };

  const exportWorker: Worker<ExportPayload, { assetId: string; durationMs: number }> = {
    kind: "export",
    async handle(payload, ctx) {
      const asset = store.getAssetByKind(payload.projectId, "original");
      if (!asset) throw new Error("No original media asset for project");
      const state = store.loadTimeline(payload.projectId);
      if (!state) throw new Error("No timeline for project");
      await ctx.progress({ progress: 0.1, stage: "rendering" });

      const outputTemp = storage.tempFile("mp4");
      await storage.withLocalFile(asset.storageKey, async (inputPath) => {
        await exportTimeline({ inputPath, timeline: state.current, outputPath: outputTemp });
      });

      await ctx.progress({ progress: 0.85, stage: "storing" });
      const key = `exports/${payload.projectId}/${Date.now()}.mp4`;
      const put = await storage.putFile(key, outputTemp, { move: true });
      const assetId = `export_${Date.now()}`;
      const { timelineDurationMs } = await import("@cutos/timeline");
      const durationMs = timelineDurationMs(state.current);
      store.addAsset({
        id: assetId,
        projectId: payload.projectId,
        kind: "export",
        mimeType: "video/mp4",
        storageKey: key,
        checksum: put.checksum,
        sizeBytes: put.size,
        durationMs,
        width: asset.width,
        height: asset.height,
        codec: "h264",
        createdAt: Date.now(),
      });
      await ctx.progress({ progress: 1, stage: "done" });
      return { assetId, durationMs };
    },
  };

  const runner = new WorkerRunner(jobStore, [analyzeWorker, exportWorker], {
    staleMs: config.jobStaleMs,
    onError: (error, job) =>
      logger.child({ jobId: job.id, projectId: job.projectId ?? undefined }).error("job failed", {
        error: error instanceof Error ? error.message : String(error),
      }),
  });
  runner.start();
  logger.info("runtime initialized", { storeMode: config.storeMode });

  return { store, jobStore, storage, runner, agentRuntime, agentRunStore };
}

const globalRef = globalThis as unknown as { __cutosRuntime?: Runtime };

export function getRuntime(): Runtime {
  if (!globalRef.__cutosRuntime) {
    globalRef.__cutosRuntime = buildRuntime();
  }
  return globalRef.__cutosRuntime;
}
