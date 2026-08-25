import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { z } from "zod";
import {
  AgentRuntime,
  ToolRegistry,
  createPlanner,
  createVisionProvider,
  PlanGateway,
  EditContextSchema,
  MemoryVisualIndexStore,
  type AgentRun,
  type AgentRunStore,
  type ContextBuilder,
  type EditContext,
  type ExtractedFrame,
  type FrameExtractor,
  type Tool,
} from "@cutos/agent";
import {
  DEFAULT_FRAME_WIDTH,
  assertProjectAsset,
  extractJpegFrame,
  exportTimeline,
  frameObjectKey,
  probeMetadata,
  runAnalysis,
  sampleWindowTimes,
  type AnalysisSection,
} from "@cutos/media";
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
import { createTimeline } from "@cutos/timeline";
import { config } from "./config.js";
import { logger } from "./logger.js";

export interface Runtime {
  store: ProjectStore;
  jobStore: JobStore;
  storage: LocalStorageAdapter;
  runner: WorkerRunner;
  agentRuntime: AgentRuntime;
  agentRunStore: AgentRunStore;
  frames: FrameExtractor;
  /**
   * Repair projects left mid-probe by a process that died. Exposed so a test
   * can drive it deterministically instead of waiting on the interval.
   */
  reconcileStuckProbes: (now?: number) => number;
}

interface AnalyzePayload {
  projectId: string;
  sections: AnalysisSection[];
  silenceOptions?: { thresholdDb?: number; minSilenceMs?: number };
}

interface ExportPayload {
  projectId: string;
}

interface ProbePayload {
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
  const createEditPlanTool: Tool<
    { instruction: string; context: EditContext; operations?: unknown[]; summary?: string },
    unknown
  > = {
    name: "create_edit_plan",
    description: "Turn a natural-language instruction into a validated Edit Plan and stage it for review.",
    permission: "plan",
    argsSchema: z.object({
      instruction: z.string().min(1),
      context: EditContextSchema,
      operations: z.array(z.unknown()).optional(),
      summary: z.string().optional(),
    }),
    async execute(args, ctx) {
      const gateway = new PlanGateway(createPlanner());
      const request = {
        instruction: args.instruction,
        sourceDurationMs: args.context.sourceDurationMs,
        silences: args.context.silences,
        targetRevision: args.context.timelineRevision,
      };
      const result = args.operations
        ? gateway.wrap({ summary: args.summary ?? "Proposed edits", operations: args.operations }, request)
        : await gateway.plan(request);
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
      const asset = store.getAssetByKind(projectId, "original");
      return {
        sourceDurationMs: project.source.durationMs,
        timelineRevision: timeline?.revision ?? project.timelineRevision,
        silences: analysis?.silences ?? [],
        transcriptSentences: analysis?.transcript?.sentences.map((s) => ({
          startMs: s.startMs,
          endMs: s.endMs,
          text: s.text,
          speaker: s.speaker,
        })),
        scenes: analysis?.scenes,
        mediaChecksum: asset?.checksum ?? analysis?.mediaChecksum,
      };
    },
  };

  async function extractProjectFrame(projectId: string, timeMs: number): Promise<ExtractedFrame> {
    const project = store.requireProject(projectId);
    const asset = store.getAssetByKind(projectId, "original");
    if (!asset) throw new Error("No original media asset for project");
    assertProjectAsset(asset, projectId);
    const clamped = Math.max(0, Math.min(project.source.durationMs, Math.round(timeMs)));
    const cacheKey = frameObjectKey({
      projectId,
      mediaChecksum: asset.checksum,
      timeMs: clamped,
      width: DEFAULT_FRAME_WIDTH,
    });
    if (await storage.exists(cacheKey)) {
      const jpeg = await storage.get(cacheKey);
      return { timeMs: clamped, mimeType: "image/jpeg", width: DEFAULT_FRAME_WIDTH, height: 0, data: jpeg };
    }
    const extracted = await storage.withLocalFile(asset.storageKey, (filePath) =>
      extractJpegFrame(filePath, clamped, { width: DEFAULT_FRAME_WIDTH }),
    );
    await storage.put(cacheKey, extracted.jpeg);
    return {
      timeMs: extracted.timeMs,
      mimeType: "image/jpeg",
      width: extracted.width,
      height: 0,
      data: extracted.jpeg,
    };
  }

  async function extractProjectFrameWindow(input: {
    projectId: string;
    centerMs: number;
    beforeMs: number;
    afterMs: number;
    samples: number;
  }): Promise<ExtractedFrame[]> {
    const project = store.requireProject(input.projectId);
    const times = sampleWindowTimes({
      centerMs: input.centerMs,
      beforeMs: input.beforeMs,
      afterMs: input.afterMs,
      samples: input.samples,
      durationMs: project.source.durationMs,
    });
    const frames: ExtractedFrame[] = [];
    for (const timeMs of times) {
      frames.push(await extractProjectFrame(input.projectId, timeMs));
    }
    return frames;
  }

  const frames: FrameExtractor = {
    extractFrame: (projectId, timeMs) => extractProjectFrame(projectId, timeMs),
    extractFrameWindow: (input) => extractProjectFrameWindow(input),
  };

  const agentRuntime = new AgentRuntime({
    registry,
    contextBuilder,
    runStore: agentRunStore,
    conversation: {
      vision: createVisionProvider(process.env, (usage) => {
        logger.info("model call", {
          provider: usage.provider,
          model: usage.model,
          task: usage.task,
          latencyMs: usage.latencyMs,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          cost: usage.cost,
        });
      }),
      frames,
      visualIndex: new MemoryVisualIndexStore(),
    },
  });

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

  /**
   * Read the real metadata of already-uploaded media.
   *
   * This used to run inline in the upload request, which is why a large file
   * appeared to hang: the browser waited on ffprobe over a file the server was
   * still writing. As a job it can retry, report progress, and — crucially —
   * be re-run on a project whose media is already stored, so a probe failure
   * never costs the user a second upload.
   */
  const probeWorker: Worker<ProbePayload, { durationMs: number }> = {
    kind: "probe",
    async handle(payload, ctx) {
      const asset = store.getAssetByKind(payload.projectId, "original");
      if (!asset) throw new Error("No original media asset for project");
      await ctx.progress({ progress: 0.1, stage: "probing" });

      let meta;
      try {
        meta = await storage.withLocalFile(asset.storageKey, (filePath) => probeMetadata(filePath));
      } catch (error) {
        // The bytes stay exactly where they are; only the project is marked.
        store.updateProject(payload.projectId, {
          mediaStatus: "failed",
          mediaError: "PROBE_FAILED",
        });
        throw error;
      }
      if (!meta.hasVideo && !meta.hasAudio) {
        store.updateProject(payload.projectId, {
          mediaStatus: "failed",
          mediaError: "MEDIA_UNSUPPORTED",
        });
        throw new Error("File has no video or audio stream");
      }

      const source = {
        id: payload.projectId,
        uri: `storage://${asset.storageKey}`,
        durationMs: meta.durationMs,
        hasAudio: meta.hasAudio,
      };
      store.updateProject(payload.projectId, {
        source,
        width: meta.width,
        height: meta.height,
        mediaStatus: "ready",
        mediaError: null,
      });
      // The placeholder timeline was built against a zero-length source; now
      // that the real duration is known it has to cover the whole clip. Only
      // an untouched timeline is replaced — a re-probe must never discard
      // edits the user already made.
      const state = store.loadTimeline(payload.projectId);
      const untouched =
        !state || (state.revision === 0 && state.past.length === 0 && state.future.length === 0);
      if (untouched) {
        store.saveTimeline(payload.projectId, {
          revision: 0,
          current: createTimeline(source),
          past: [],
          future: [],
        });
      }
      store.media.addAsset({
        ...asset,
        durationMs: meta.durationMs,
        width: meta.width,
        height: meta.height,
        codec: meta.videoCodec,
      });

      await ctx.progress({ progress: 1, stage: "done" });
      return { durationMs: meta.durationMs };
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

  /**
   * Repair projects whose probe died without recording an outcome.
   *
   * The probe worker writes `mediaStatus: "failed"` from its own catch block —
   * but a job can reach a terminal state without that catch ever running. If
   * the process is killed mid-ffprobe (an OOM while probing a large phone
   * video is the ordinary way this happens) the store's stale-recovery fails
   * the job on the worker's behalf, and nothing ever touches the project row.
   * It stays "probing" forever.
   *
   * That is unrecoverable from the UI, because the re-probe affordance only
   * appears for "failed": the user sees 處理中 with no button that can move it
   * forward, and no amount of waiting or reopening helps. Reconciling here
   * turns a permanent lockout into a retryable failure.
   */
  function reconcileStuckProbes(now = Date.now()): number {
    // A freshly created project is briefly "uploaded" before its probe is
    // enqueued; the grace period keeps that window from being mistaken for a
    // dead probe.
    const graceMs = 30_000;
    let repaired = 0;
    for (const project of store.listProjects()) {
      if (project.mediaStatus !== "probing" && project.mediaStatus !== "uploaded") continue;
      if (now - project.updatedAt < graceMs) continue;
      const jobs = jobStore.list({ kind: "probe", projectId: project.id });
      const pending = jobs.some((job) => job.status === "queued" || job.status === "running");
      if (pending) continue;
      store.updateProject(project.id, { mediaStatus: "failed", mediaError: "PROBE_FAILED" });
      repaired += 1;
      logger.child({ projectId: project.id }).warn("probe left the project stuck; marked failed", {
        previousStatus: project.mediaStatus,
      });
    }
    return repaired;
  }

  const runner = new WorkerRunner(jobStore, [probeWorker, analyzeWorker, exportWorker], {
    staleMs: config.jobStaleMs,
    onError: (error, job) =>
      logger.child({ jobId: job.id, projectId: job.projectId ?? undefined }).error("job failed", {
        error: error instanceof Error ? error.message : String(error),
      }),
  });
  runner.start();
  // Startup is exactly when a previous process's abandoned probes need
  // repairing, and the interval catches one that dies while we are running.
  reconcileStuckProbes();
  const reconcileTimer = setInterval(() => {
    try {
      reconcileStuckProbes();
    } catch (error) {
      logger.error("probe reconciliation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, 30_000);
  reconcileTimer.unref?.();
  logger.info("runtime initialized", { storeMode: config.storeMode });

  return { store, jobStore, storage, runner, agentRuntime, agentRunStore, frames, reconcileStuckProbes };
}

const globalRef = globalThis as unknown as { __cutosRuntime?: Runtime };

/**
 * Validate the deployment, once, as soon as there is a runtime to validate.
 *
 * This is the boot-time check that turns a silently-misconfigured container
 * into a loud one: an unwritable data directory or a missing ffprobe is logged
 * with its reason and its remedy here, rather than discovered by whoever
 * uploads next.
 *
 * Fired rather than awaited, for two reasons. `getRuntime` is synchronous and
 * every route depends on it, so blocking would delay the first request behind a
 * diagnostic; and preflight calls `getRuntime` itself, so it can only run once
 * the global below is already assigned. Imported dynamically for the same
 * reason — a static import would be a cycle.
 */
let preflightFired = false;

function firePreflight(): void {
  if (preflightFired) return;
  preflightFired = true;
  if (process.env.CUTOS_SKIP_PREFLIGHT === "1") return;
  void import("./diagnostics.js")
    .then(({ runStartupPreflight }) => runStartupPreflight())
    .catch((error: unknown) => {
      // Never allowed to take down the server it is reporting on.
      logger.error("startup preflight crashed", {
        error: error instanceof Error ? error.message : String(error),
        hint: "GET /api/health for the full report.",
      });
    });
}

export function getRuntime(): Runtime {
  if (!globalRef.__cutosRuntime) {
    try {
      globalRef.__cutosRuntime = buildRuntime();
    } finally {
      // In a `finally`, not after the assignment — because the case that most
      // needs logging is the one where `buildRuntime` THROWS. A data directory
      // that cannot be created kills it at the first `mkdirSync`, and putting
      // this on the success path meant the single most important failure was
      // the only one that stayed silent.
      //
      // Re-entrant by construction: preflight calls `getRuntime` itself, and on
      // a broken deployment that call throws again and lands back here. The
      // `preflightFired` latch stops that from looping.
      firePreflight();
    }
  }
  return globalRef.__cutosRuntime;
}
