import { z } from "zod";
import { checkAiosConnection, describeProvider, readAiosConfig } from "@cutos/agent";
import * as service from "./editor-service.js";
import { HttpError } from "./errors.js";

/**
 * Outbound AIOS integration: exposes CUTOS's editing capabilities as a
 * machine-readable manifest + a single validated invoke entrypoint, so an
 * external AIOS agent can drive CUTOS end-to-end (import → analyze → plan →
 * apply → export). Every capability is schema-validated and permission-tagged;
 * nothing accepts a raw file path (media is only referenced by projectId).
 */

export interface CapabilityParam {
  name: string;
  type: "string" | "number";
  required: boolean;
  description?: string;
}

interface Capability<T> {
  name: string;
  description: string;
  permission: "read" | "write";
  params: CapabilityParam[];
  schema: z.ZodType<T>;
  run: (args: T) => Promise<unknown> | unknown;
}

const projectId = z.string().min(1);

function cap<T>(c: Capability<T>): Capability<unknown> {
  return c as unknown as Capability<unknown>;
}

const capabilities: Capability<unknown>[] = [
  cap({
    name: "list_projects",
    description: "列出所有專案。List all projects.",
    permission: "read",
    params: [],
    schema: z.object({}).strip(),
    run: () => service.listProjects(),
  }),
  cap({
    name: "create_sample_project",
    description: "建立內建示範專案。Create a demo project from the built-in sample.",
    permission: "write",
    params: [],
    schema: z.object({}).strip(),
    run: async () => ({ projectId: await service.importSample() }),
  }),
  cap({
    name: "get_project",
    description: "取得專案狀態（含時間軸與預覽 manifest）。Get full project state.",
    permission: "read",
    params: [{ name: "projectId", type: "string", required: true }],
    schema: z.object({ projectId }),
    run: (a: { projectId: string }) => service.getProject(a.projectId),
  }),
  cap({
    name: "analyze",
    description: "分析影片（停頓、波形、字幕）。Enqueue media analysis. Returns a jobId.",
    permission: "write",
    params: [{ name: "projectId", type: "string", required: true }],
    schema: z.object({ projectId }),
    run: (a: { projectId: string }) => ({ jobId: service.enqueueAnalyze(a.projectId) }),
  }),
  cap({
    name: "plan",
    description: "用自然語言指令建立剪輯計畫。Create an edit plan from a natural-language instruction.",
    permission: "write",
    params: [
      { name: "projectId", type: "string", required: true },
      { name: "instruction", type: "string", required: true, description: "支援中文" },
    ],
    schema: z.object({ projectId, instruction: z.string().min(1).max(2000) }),
    run: (a: { projectId: string; instruction: string }) => service.plan(a.projectId, a.instruction),
  }),
  cap({
    name: "preview_operation",
    description: "取得單一操作的暫時預覽 manifest（不改動時間軸）。Ephemeral preview of one pending op.",
    permission: "read",
    params: [
      { name: "projectId", type: "string", required: true },
      { name: "opIndex", type: "number", required: true },
    ],
    schema: z.object({ projectId, opIndex: z.number().int().nonnegative() }),
    run: (a: { projectId: string; opIndex: number }) => service.previewOperationManifest(a.projectId, a.opIndex),
  }),
  cap({
    name: "reject_operation",
    description: "從待審核計畫移除一項操作。Reject one operation in the pending plan.",
    permission: "write",
    params: [
      { name: "projectId", type: "string", required: true },
      { name: "opIndex", type: "number", required: true },
    ],
    schema: z.object({ projectId, opIndex: z.number().int().nonnegative() }),
    run: (a: { projectId: string; opIndex: number }) => service.rejectOperation(a.projectId, a.opIndex),
  }),
  cap({
    name: "apply",
    description: "套用待審核計畫到時間軸。Apply the pending plan to the timeline.",
    permission: "write",
    params: [{ name: "projectId", type: "string", required: true }],
    schema: z.object({ projectId }),
    run: (a: { projectId: string }) => service.applyPending(a.projectId),
  }),
  cap({
    name: "undo",
    description: "復原上一個剪輯。Undo the last edit.",
    permission: "write",
    params: [{ name: "projectId", type: "string", required: true }],
    schema: z.object({ projectId }),
    run: (a: { projectId: string }) => service.undo(a.projectId),
  }),
  cap({
    name: "redo",
    description: "重做剪輯。Redo.",
    permission: "write",
    params: [{ name: "projectId", type: "string", required: true }],
    schema: z.object({ projectId }),
    run: (a: { projectId: string }) => service.redo(a.projectId),
  }),
  cap({
    name: "export",
    description: "輸出影片。Enqueue an FFmpeg export. Returns a jobId.",
    permission: "write",
    params: [{ name: "projectId", type: "string", required: true }],
    schema: z.object({ projectId }),
    run: (a: { projectId: string }) => ({ jobId: service.enqueueExport(a.projectId) }),
  }),
  cap({
    name: "get_job",
    description: "查詢背景工作狀態。Get a background job's status.",
    permission: "read",
    params: [{ name: "jobId", type: "string", required: true }],
    schema: z.object({ jobId: z.string().min(1) }),
    run: (a: { jobId: string }) => service.getJob(a.jobId),
  }),
];

export function getAiosManifest() {
  return {
    agent: "cutos",
    displayName: "CUTOS — AI 對話式影片剪輯代理",
    version: 1,
    protocol: "cutos.agent.v1",
    provider: describeProvider(),
    capabilities: capabilities.map((c) => ({
      name: c.name,
      description: c.description,
      permission: c.permission,
      params: c.params,
    })),
  };
}

export function listCapabilityNames(): string[] {
  return capabilities.map((c) => c.name);
}

/** Probe the configured AIOS kernel (inbound) for connectivity. */
export async function checkAiosHealth() {
  const config = readAiosConfig();
  if (!config.configured || !config.kernelUrl) {
    return { configured: false as const };
  }
  const status = await checkAiosConnection({
    kernelUrl: config.kernelUrl,
    healthPath: config.healthPath,
  });
  return { configured: true as const, ...status };
}

export async function invokeAiosCapability(name: string, rawArgs: unknown) {
  const capability = capabilities.find((c) => c.name === name);
  if (!capability) {
    throw new HttpError(404, "OPERATION_NOT_FOUND", `Unknown capability: ${name}`);
  }
  const parsed = capability.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    throw new HttpError(
      400,
      "VALIDATION_FAILED",
      parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; "),
    );
  }
  const result = await capability.run(parsed.data);
  return { capability: name, result };
}
