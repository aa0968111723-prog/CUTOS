import type { ZodType } from "zod";

/** Coarse-grained capabilities a tool may require. */
export type AgentPermission = "read" | "analyze" | "plan" | "apply" | "export";

export interface ToolContext {
  runId: string;
  projectId: string;
  /** Capabilities granted to this run; tools requiring more are denied. */
  permissions: Set<AgentPermission>;
  signal?: AbortSignal;
}

/**
 * A typed, runtime-validated, permission-aware tool. Every agent capability is
 * a Tool so calls are schema-checked and traceable — the agent never invokes
 * FFmpeg or mutates state through ad-hoc code paths.
 */
export interface Tool<TArgs = unknown, TResult = unknown> {
  readonly name: string;
  readonly description: string;
  readonly permission: AgentPermission;
  readonly argsSchema: ZodType<TArgs>;
  execute(args: TArgs, ctx: ToolContext): Promise<TResult>;
}

export interface ToolCallRecord {
  id: string;
  tool: string;
  args: unknown;
  status: "ok" | "error";
  result?: unknown;
  error?: string;
  startedAt: number;
  finishedAt: number;
}

export class ToolPermissionError extends Error {
  constructor(tool: string, permission: AgentPermission) {
    super(`Tool "${tool}" requires permission "${permission}" which was not granted`);
    this.name = "ToolPermissionError";
  }
}

export class ToolValidationError extends Error {
  constructor(tool: string, public readonly issues: string[]) {
    super(`Invalid arguments for tool "${tool}": ${issues.join("; ")}`);
    this.name = "ToolValidationError";
  }
}

export class UnknownToolError extends Error {
  constructor(tool: string) {
    super(`Unknown tool "${tool}"`);
    this.name = "UnknownToolError";
  }
}

export interface ToolInvocation {
  record: ToolCallRecord;
  result: unknown;
}

/**
 * Registry of tools. `call` validates arguments against the tool schema,
 * enforces permissions and records a traceable {@link ToolCallRecord}.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(
    private readonly deps: {
      now?: () => number;
      createId?: () => string;
    } = {},
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
  private id(): string {
    return (this.deps.createId ?? (() => `call_${Math.random().toString(36).slice(2, 10)}`))();
  }

  register<TArgs, TResult>(tool: Tool<TArgs, TResult>): void {
    this.tools.set(tool.name, tool as unknown as Tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): { name: string; description: string; permission: AgentPermission }[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      permission: t.permission,
    }));
  }

  async call(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolInvocation> {
    const tool = this.tools.get(name);
    if (!tool) throw new UnknownToolError(name);
    if (!ctx.permissions.has(tool.permission)) {
      throw new ToolPermissionError(name, tool.permission);
    }

    const parsed = tool.argsSchema.safeParse(rawArgs);
    if (!parsed.success) {
      throw new ToolValidationError(
        name,
        parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`),
      );
    }

    const startedAt = this.now();
    const id = this.id();
    try {
      const result = await tool.execute(parsed.data, ctx);
      return {
        result,
        record: { id, tool: name, args: parsed.data, status: "ok", result, startedAt, finishedAt: this.now() },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        result: undefined,
        record: { id, tool: name, args: parsed.data, status: "error", error: message, startedAt, finishedAt: this.now() },
      };
    }
  }
}
