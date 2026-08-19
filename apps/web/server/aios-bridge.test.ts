import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "@cutos/media";
import type * as AiosBridge from "./aios-bridge.js";
import type * as EditorService from "./editor-service.js";

/**
 * The AIOS outbound bridge: manifest correctness, validation, and that a
 * capability invocation actually dispatches into the editor service.
 */
describe("AIOS bridge", () => {
  let dir = "";
  let available = false;
  let bridge: typeof AiosBridge;
  let service: typeof EditorService;

  beforeAll(async () => {
    try {
      await run("ffmpeg", ["-version"]);
      available = true;
    } catch {
      available = false;
    }
    dir = await mkdtemp(join(tmpdir(), "cutos-aios-"));
    process.env.CUTOS_DATA_DIR = dir;
    process.env.CUTOS_STORE = "memory";
    bridge = await import("./aios-bridge.js");
    service = await import("./editor-service.js");
  }, 30_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("exposes a capability manifest with provider info", () => {
    const manifest = bridge.getAiosManifest();
    expect(manifest.agent).toBe("cutos");
    expect(manifest.protocol).toBe("cutos.agent.v1");
    const names = manifest.capabilities.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["plan", "apply", "export", "get_project", "analyze"]));
    // Provider defaults to the offline planner in tests.
    expect(manifest.provider.provider).toBe("local");
    expect(manifest.provider.aios.configured).toBe(false);
  });

  it("rejects unknown capabilities and invalid args", async () => {
    await expect(bridge.invokeAiosCapability("does_not_exist", {})).rejects.toMatchObject({
      code: "OPERATION_NOT_FOUND",
    });
    await expect(bridge.invokeAiosCapability("plan", { projectId: "" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it("invokes read capabilities", async () => {
    const res = await bridge.invokeAiosCapability("list_projects", {});
    expect(res.capability).toBe("list_projects");
    expect(Array.isArray(res.result)).toBe(true);
  });

  it("reports AIOS health as not-configured when no kernel URL is set", async () => {
    const health = await bridge.checkAiosHealth();
    expect(health.configured).toBe(false);
  });

  it("drives CUTOS end-to-end through the bridge (create → analyze → plan → apply)", async () => {
    if (!available) return;
    const created = (await bridge.invokeAiosCapability("create_sample_project", {})).result as {
      projectId: string;
    };
    expect(created.projectId).toBeTruthy();

    const analyze = (await bridge.invokeAiosCapability("analyze", { projectId: created.projectId }))
      .result as { jobId: string };
    // Wait for the analyze job to finish.
    for (let i = 0; i < 200; i += 1) {
      const job = service.getJob(analyze.jobId);
      if (job.status === "succeeded") break;
      if (job.status === "failed") throw new Error(job.error ?? "analyze failed");
      await new Promise((r) => setTimeout(r, 100));
    }

    const planned = (await bridge.invokeAiosCapability("plan", {
      projectId: created.projectId,
      instruction: "刪掉超過 1 秒的停頓",
    })).result as { dto: { pendingPlan?: { operations: unknown[] } } };
    expect((planned.dto.pendingPlan?.operations.length ?? 0)).toBeGreaterThanOrEqual(3);

    const applied = (await bridge.invokeAiosCapability("apply", { projectId: created.projectId }))
      .result as { timeline: { durationMs: number }; source: { durationMs: number } };
    expect(applied.timeline.durationMs).toBeLessThan(applied.source.durationMs);
  }, 120_000);
});
