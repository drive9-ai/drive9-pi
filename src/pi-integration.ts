import {
  createEditTool,
  createReadTool,
  createWriteTool,
  err,
  ExecutionError,
  getOrThrow,
  type AfterToolCallContext,
  type AfterToolCallResult,
  type AgentHarnessTool,
  type AgentOptions,
  type AgentTool,
  type ExecutionEnv,
  type ExecutionToolContext,
  type FileSystem,
  type ReadToolOptions,
  type Shell,
  type ShellExecOptions,
} from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { Drive9FileSystem, type Drive9FileSystemClient } from "./drive9-file-system.js";
import { createDrive9ResultStore, type Drive9ResultClient } from "./drive9-result-backend.js";
import {
  createAfterToolCallFallback,
  createResultReadTool,
  createResultSearchTool,
} from "./pi-adapters.js";
import type { PersistentToolResultStore } from "./tool-result-store.js";

type AfterToolCall = NonNullable<AgentOptions["afterToolCall"]>;

const listParameters = Type.Object(
  { path: Type.Optional(Type.String({ description: "Directory path to list. Defaults to the workspace cwd." })) },
  { additionalProperties: false },
);

export interface Drive9PiIntegrationOptions {
  workspaceClient: Drive9FileSystemClient;
  workspaceRoot: string;
  evidenceClient: Drive9ResultClient;
  evidenceRoot: string;
  sessionId: string;
  runId: string;
  thresholdBytes?: number;
  previewBytes?: number;
  readTool?: ReadToolOptions;
  shell?: Shell;
  harnessTools?: readonly AgentHarnessTool<ExecutionToolContext>[];
}

export interface CreateDrive9FileToolsOptions {
  fileSystem: Drive9FileSystem;
  readTool?: ReadToolOptions;
}

export interface Drive9PiIntegration {
  fileSystem: Drive9FileSystem;
  resultStore: PersistentToolResultStore;
  executionEnv: ExecutionEnv;
  tools: AgentTool[];
  afterToolCall: AfterToolCall;
  withAgentOptions(options: AgentOptions): AgentOptions;
  cleanup(): Promise<void>;
}

class Drive9IntegrationExecutionEnv implements ExecutionEnv {
  constructor(
    private readonly fileSystem: FileSystem,
    private readonly shell?: Shell,
  ) {}

  get cwd(): string {
    return this.fileSystem.cwd;
  }

  set cwd(value: string) {
    this.fileSystem.cwd = value;
  }

  absolutePath: FileSystem["absolutePath"] = async (...args) => await this.fileSystem.absolutePath(...args);
  joinPath: FileSystem["joinPath"] = async (...args) => await this.fileSystem.joinPath(...args);
  readTextFile: FileSystem["readTextFile"] = async (...args) => await this.fileSystem.readTextFile(...args);
  readTextLines: FileSystem["readTextLines"] = async (...args) => await this.fileSystem.readTextLines(...args);
  readBinaryFile: FileSystem["readBinaryFile"] = async (...args) => await this.fileSystem.readBinaryFile(...args);
  writeFile: FileSystem["writeFile"] = async (...args) => await this.fileSystem.writeFile(...args);
  appendFile: FileSystem["appendFile"] = async (...args) => await this.fileSystem.appendFile(...args);
  renameFile: FileSystem["renameFile"] = async (...args) => await this.fileSystem.renameFile(...args);
  fileInfo: FileSystem["fileInfo"] = async (...args) => await this.fileSystem.fileInfo(...args);
  listDir: FileSystem["listDir"] = async (...args) => await this.fileSystem.listDir(...args);
  canonicalPath: FileSystem["canonicalPath"] = async (...args) => await this.fileSystem.canonicalPath(...args);
  exists: FileSystem["exists"] = async (...args) => await this.fileSystem.exists(...args);
  createDir: FileSystem["createDir"] = async (...args) => await this.fileSystem.createDir(...args);
  remove: FileSystem["remove"] = async (...args) => await this.fileSystem.remove(...args);
  createTempDir: FileSystem["createTempDir"] = async (...args) => await this.fileSystem.createTempDir(...args);
  createTempFile: FileSystem["createTempFile"] = async (...args) => await this.fileSystem.createTempFile(...args);

  async exec(command: string, options?: ShellExecOptions): ReturnType<ExecutionEnv["exec"]> {
    if (this.shell === undefined) {
      return err(new ExecutionError("shell_unavailable", "Drive9 Pi integration does not provide a shell"));
    }
    const cwd = await this.fileSystem.absolutePath(options?.cwd ?? this.cwd, options?.abortSignal);
    if (!cwd.ok) {
      return err(
        new ExecutionError(
          cwd.error.code === "aborted" ? "aborted" : "spawn_error",
          `Cannot resolve shell working directory: ${cwd.error.message}`,
          cwd.error,
        ),
      );
    }
    return await this.shell.exec(command, { ...options, cwd: cwd.value });
  }

  async cleanup(): Promise<void> {
    await Promise.allSettled([this.fileSystem.cleanup(), ...(this.shell === undefined ? [] : [this.shell.cleanup()])]);
  }
}

function bindFileTool(tool: AgentHarnessTool<ExecutionToolContext>, env: ExecutionEnv): AgentTool {
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) =>
      await tool.execute(toolCallId, params, signal, onUpdate, { env }),
  };
}

function createListTool(env: ExecutionEnv): AgentTool<typeof listParameters, undefined> {
  return {
    name: "list",
    label: "list",
    description: "List the direct children of a Drive9 workspace directory.",
    parameters: listParameters,
    execute: async (_toolCallId, { path }, signal) => {
      const entries = getOrThrow(await env.listDir(path ?? ".", signal));
      const text =
        entries.length === 0
          ? "(empty directory)"
          : entries.map((entry) => `${entry.kind}\t${entry.size}\t${entry.name}`).join("\n");
      return { content: [{ type: "text", text }], details: undefined };
    },
  };
}

function createBoundFileTools(env: ExecutionEnv, readTool?: ReadToolOptions): AgentTool[] {
  return [
    bindFileTool(createReadTool(readTool), env),
    bindFileTool(createWriteTool(), env),
    bindFileTool(createEditTool(), env),
    createListTool(env),
  ];
}

/** Return Pi file tools already bound to the supplied Drive9 filesystem. */
export function createDrive9FileTools(options: CreateDrive9FileToolsOptions): AgentTool[] {
  return createBoundFileTools(new Drive9IntegrationExecutionEnv(options.fileSystem), options.readTool);
}

function applyAfterToolCallOverride(
  context: AfterToolCallContext,
  override: AfterToolCallResult,
): AfterToolCallContext {
  return {
    ...context,
    result: {
      ...context.result,
      ...(override.content === undefined ? {} : { content: override.content }),
      ...(override.details === undefined ? {} : { details: override.details }),
      ...(override.usage === undefined ? {} : { usage: override.usage }),
      ...(override.terminate === undefined ? {} : { terminate: override.terminate }),
    },
    isError: override.isError ?? context.isError,
  };
}

export function chainAfterToolCall(first: AfterToolCall, second: AfterToolCall): AfterToolCall {
  return async (context, signal) => {
    const firstResult = await first(context, signal);
    const secondResult = await second(
      firstResult === undefined ? context : applyAfterToolCallOverride(context, firstResult),
      signal,
    );
    if (firstResult === undefined) return secondResult;
    if (secondResult === undefined) return firstResult;
    return { ...firstResult, ...secondResult };
  };
}

function assertUniqueTools(existing: AgentTool[], added: AgentTool[]): void {
  const names = new Set(existing.map((tool) => tool.name));
  for (const tool of added) {
    if (names.has(tool.name)) throw new TypeError(`Agent already defines a tool named ${tool.name}`);
    names.add(tool.name);
  }
}

function nonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be non-empty`);
  return value;
}

export function createDrive9PiIntegration(options: Drive9PiIntegrationOptions): Drive9PiIntegration {
  const sessionId = nonEmpty(options.sessionId, "sessionId");
  const runId = nonEmpty(options.runId, "runId");
  const fileSystem = new Drive9FileSystem({ client: options.workspaceClient, root: options.workspaceRoot });
  const resultStore = createDrive9ResultStore({ client: options.evidenceClient, evidenceRoot: options.evidenceRoot });
  const env = new Drive9IntegrationExecutionEnv(fileSystem, options.shell);
  const fileTools = createBoundFileTools(env, options.readTool);
  const harnessTools = (options.harnessTools ?? []).map((tool) => bindFileTool(tool, env));
  const resultTools = [
    createResultReadTool({ store: resultStore, currentSessionId: () => sessionId }),
    createResultSearchTool({ store: resultStore, currentSessionId: () => sessionId }),
  ];
  const tools = [...fileTools, ...harnessTools, ...resultTools];
  assertUniqueTools([], tools);
  const fallback = createAfterToolCallFallback({
    store: resultStore,
    allocateIdentity: ({ toolCallId }) => ({ sessionId, runId, toolCallId, attempt: 0 }),
    ...(options.thresholdBytes === undefined ? {} : { thresholdBytes: options.thresholdBytes }),
    ...(options.previewBytes === undefined ? {} : { previewBytes: options.previewBytes }),
  });

  return {
    fileSystem,
    resultStore,
    executionEnv: env,
    tools: [...tools],
    afterToolCall: fallback,
    withAgentOptions: (agentOptions) => {
      if (agentOptions.sessionId !== undefined && agentOptions.sessionId !== sessionId) {
        throw new TypeError("Agent sessionId must match the Drive9 integration sessionId");
      }
      const existingTools = agentOptions.initialState?.tools ?? [];
      assertUniqueTools(existingTools, tools);
      return {
        ...agentOptions,
        sessionId,
        initialState: {
          ...(agentOptions.initialState ?? {}),
          tools: [...existingTools, ...tools],
        },
        afterToolCall:
          agentOptions.afterToolCall === undefined
            ? fallback
            : chainAfterToolCall(agentOptions.afterToolCall, fallback),
      };
    },
    cleanup: async () => await env.cleanup(),
  };
}
