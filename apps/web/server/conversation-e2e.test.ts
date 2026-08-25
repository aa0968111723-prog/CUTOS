import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "@cutos/media";
import type * as EditorService from "./editor-service.js";

/**
 * Conversational vision path: inspect a playhead without creating an empty
 * Edit Plan, then "從這裡開始" produces a validated trim through the DSL.
 *
 * Uses the real FFmpeg extractor. Vision is the Unavailable provider unless
 * CUTOS_ZEABUR_AI_API_KEY is set, in which case the inspect turn hits Zeabur.
 */
describe("conversation E2E (inspect → grounded trim)", () => {
  let dir = "";
  let available = false;
  let service: typeof EditorService;

  beforeAll(async () => {
    try {
      await run("ffmpeg", ["-version"]);
      available = true;
    } catch {
      available = false;
    }
    dir = await mkdtemp(join(tmpdir(), "cutos-vision-e2e-"));
    process.env.CUTOS_DATA_DIR = dir;
    process.env.CUTOS_STORE = "sqlite";
    service = await import("./editor-service.js");
  }, 30_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("inspects 00:25 then trims from that grounding", async () => {
    if (!available) return;

    const projectId = await service.importGeneratedClip({
      durationSec: 32,
      name: "Vision clip (32s)",
    });
    expect(service.getProject(projectId).source.durationMs).toBeGreaterThan(30_000);

    const inspect = await service.plan(projectId, "這裡你看得到嗎？", { playheadMs: 25_000 });
    expect(inspect.dto.pendingPlan).toBeUndefined();
    expect(inspect.status).not.toBe("failed");
    expect(inspect.turn?.type).toBe("answer");
    expect(inspect.turn?.message ?? "").not.toMatch(/Array must contain at least 1 element/);
    expect(inspect.turn?.message ?? "").not.toMatch(/operations:/);

    const live = Boolean(process.env.CUTOS_ZEABUR_AI_API_KEY);
    if (live) {
      expect(inspect.turn?.message).toMatch(/可以|畫面|女生|圖案|色/);
    } else {
      expect(inspect.turn?.message).toContain("尚未設定影片視覺理解模型");
    }

    const frames = await service.extractFrameWindow({
      projectId,
      centerMs: 25_000,
      beforeMs: 1_000,
      afterMs: 1_000,
      samples: 5,
    });
    expect(frames.length).toBeGreaterThanOrEqual(3);
    expect(frames[0]?.data[0]).toBe(0xff);

    const edit = await service.plan(projectId, "好，就從這裡開始。", { playheadMs: 25_000 });
    expect(edit.status).toBe("awaiting_approval");
    expect(edit.dto.pendingPlan).toBeDefined();
    const trim = edit.dto.pendingPlan?.operations[0];
    expect(trim?.type).toBe("trim");
    expect(trim?.startMs).toBeGreaterThanOrEqual(24_000);
    expect(trim?.startMs).toBeLessThanOrEqual(26_000);

    const applied = service.applyPending(projectId);
    expect(applied.pendingPlan).toBeUndefined();
    expect(applied.timeline.clips[0]?.sourceInMs).toBeGreaterThanOrEqual(24_000);
    expect(applied.preview.segments[0]?.sourceInMs).toBeGreaterThanOrEqual(24_000);
    expect(applied.preview.durationMs).toBeLessThan(applied.source.durationMs);
  }, 120_000);

  it("does not build an Edit Plan for a bare 0:25", async () => {
    if (!available) return;
    const projectId = await service.importGeneratedClip({
      durationSec: 32,
      name: "Clock inspect",
    });
    const result = await service.plan(projectId, "0:25", { playheadMs: 0 });
    expect(result.dto.pendingPlan).toBeUndefined();
    expect(result.turn?.type).toBe("answer");
    expect(result.status).toBe("completed");
  }, 60_000);
});
