import assert from "node:assert/strict";
import { posix } from "node:path";
import { describe, it } from "node:test";
import {
  Agent,
  createBashTool,
  ok,
  type AgentTool,
  type ExecutionError,
  type Shell,
  type ShellExecOptions,
} from "@earendil-works/pi-agent-core";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import {
  createDrive9PiIntegration,
  deriveResultId,
  type CompactToolResultDetails,
  type Drive9FileEntry,
  type Drive9FileSystemClient,
  type Drive9ResultClient,
  type Drive9Stat,
} from "../src/index.js";

class StatusError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

interface WorkspaceNode {
  data: Uint8Array;
  isDir: boolean;
  revision: number;
  mode: number;
  mtime: Date;
}

interface EvidenceObject {
  data: Uint8Array;
  revision: number;
}

class MemoryDrive9Client implements Drive9FileSystemClient, Drive9ResultClient {
  readonly workspace = new Map<string, WorkspaceNode>();
  readonly evidence = new Map<string, EvidenceObject>();
  readonly evidenceDirectories = new Set<string>();
  private revision = 1;

  constructor() {
    this.workspace.set("/workspace", this.node(new Uint8Array(), true, 0o40755));
  }

  text(path: string): string {
    const node = this.requireWorkspace(path);
    if (node.isDir) throw new Error(`not a file: ${path}`);
    return Buffer.from(node.data).toString("utf8");
  }

  async read(path: string): Promise<Uint8Array> {
    const workspace = this.workspace.get(path);
    if (workspace !== undefined) {
      if (workspace.isDir) throw new StatusError(400, `is a directory: ${path}`);
      return Uint8Array.from(workspace.data);
    }
    const evidence = this.evidence.get(path);
    if (evidence === undefined) throw new StatusError(404, `not found: ${path}`);
    return Uint8Array.from(evidence.data);
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    this.requireWorkspaceDirectory(posix.dirname(path));
    this.workspace.set(path, this.node(data, false, 0o100644));
  }

  async append(path: string, data: Uint8Array): Promise<void> {
    this.requireWorkspaceDirectory(posix.dirname(path));
    const current = this.workspace.get(path);
    if (current?.isDir === true) throw new StatusError(400, `is a directory: ${path}`);
    const existing = current?.data ?? new Uint8Array();
    const combined = new Uint8Array(existing.byteLength + data.byteLength);
    combined.set(existing);
    combined.set(data, existing.byteLength);
    this.workspace.set(path, this.node(combined, false, current?.mode ?? 0o100644));
  }

  async list(path: string): Promise<Drive9FileEntry[]> {
    this.requireWorkspaceDirectory(path);
    return [...this.workspace.entries()]
      .filter(([candidate]) => candidate !== path && posix.dirname(candidate) === path)
      .map(([candidate, node]) => ({
        name: posix.basename(candidate),
        size: node.data.byteLength,
        isDir: node.isDir,
        mtime: node.mtime,
        mode: node.mode,
      }));
  }

  async stat(path: string): Promise<Drive9Stat> {
    const workspace = this.workspace.get(path);
    if (workspace !== undefined) {
      return {
        size: workspace.data.byteLength,
        isDir: workspace.isDir,
        revision: workspace.revision,
        mtime: workspace.mtime,
        mode: workspace.mode,
      };
    }
    const evidence = this.evidence.get(path);
    if (evidence === undefined) throw new StatusError(404, `not found: ${path}`);
    return { size: evidence.data.byteLength, isDir: false, revision: evidence.revision };
  }

  async rename(sourcePath: string, destinationPath: string): Promise<void> {
    this.requireWorkspaceDirectory(posix.dirname(destinationPath));
    const source = this.requireWorkspace(sourcePath);
    this.workspace.delete(sourcePath);
    this.workspace.set(destinationPath, source);
  }

  async mkdir(path: string, mode = 0o755): Promise<void> {
    if (path.startsWith("/workspace")) {
      if (this.workspace.has(path)) throw new StatusError(409, `exists: ${path}`);
      this.requireWorkspaceDirectory(posix.dirname(path));
      this.workspace.set(path, this.node(new Uint8Array(), true, 0o40000 | mode));
      return;
    }
    if (this.evidenceDirectories.has(path)) throw new StatusError(409, `exists: ${path}`);
    this.evidenceDirectories.add(path);
  }

  async deleteFile(path: string): Promise<void> {
    const node = this.requireWorkspace(path);
    if (node.isDir) throw new StatusError(400, `is a directory: ${path}`);
    this.workspace.delete(path);
  }

  async deleteDir(path: string): Promise<void> {
    this.requireWorkspaceDirectory(path);
    if ([...this.workspace.keys()].some((candidate) => candidate !== path && posix.dirname(candidate) === path)) {
      throw new StatusError(400, `directory not empty: ${path}`);
    }
    this.workspace.delete(path);
  }

  async removeAll(path: string): Promise<void> {
    this.requireWorkspace(path);
    for (const candidate of [...this.workspace.keys()]) {
      if (candidate === path || candidate.startsWith(`${path}/`)) this.workspace.delete(candidate);
    }
  }

  async writeWithRevision(
    path: string,
    data: Uint8Array,
    options: { expectedRevision: number },
  ): Promise<number> {
    const current = this.evidence.get(path);
    if (options.expectedRevision === 0) {
      if (current !== undefined) throw new StatusError(409, `exists: ${path}`);
      this.evidence.set(path, { data: Uint8Array.from(data), revision: 1 });
      return 1;
    }
    if (current === undefined) throw new StatusError(404, `not found: ${path}`);
    if (current.revision !== options.expectedRevision) throw new StatusError(409, `revision mismatch: ${path}`);
    const revision = current.revision + 1;
    this.evidence.set(path, { data: Uint8Array.from(data), revision });
    return revision;
  }

  private node(data: Uint8Array, isDir: boolean, mode: number): WorkspaceNode {
    return {
      data: Uint8Array.from(data),
      isDir,
      revision: this.revision++,
      mode,
      mtime: new Date("2026-08-14T00:00:00Z"),
    };
  }

  private requireWorkspace(path: string): WorkspaceNode {
    const node = this.workspace.get(path);
    if (node === undefined) throw new StatusError(404, `not found: ${path}`);
    return node;
  }

  private requireWorkspaceDirectory(path: string): WorkspaceNode {
    const node = this.requireWorkspace(path);
    if (!node.isDir) throw new StatusError(400, `not a directory: ${path}`);
    return node;
  }
}

class RecordingShell implements Shell {
  readonly calls: Array<{ command: string; options?: ShellExecOptions }> = [];
  cleanupCalls = 0;

  async exec(command: string, options?: ShellExecOptions): ReturnType<Shell["exec"]> {
    this.calls.push({ command, ...(options === undefined ? {} : { options: { ...options } }) });
    options?.onStdout?.("sandbox output\n");
    return ok<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>({
      stdout: "sandbox output\n",
      stderr: "",
      exitCode: 0,
    });
  }

  async cleanup(): Promise<void> {
    this.cleanupCalls += 1;
  }
}

function toolResultText(message: unknown): string {
  if (typeof message !== "object" || message === null || !("role" in message) || message.role !== "toolResult") {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part
        ? String(part.text)
        : "",
    )
    .join("");
}

describe("createDrive9PiIntegration", () => {
  it("wires real Agent file tools and durable evidence without a host shell", async () => {
    const client = new MemoryDrive9Client();
    const integration = createDrive9PiIntegration({
      workspaceClient: client,
      workspaceRoot: "/workspace",
      evidenceClient: client,
      evidenceRoot: "/evidence",
      sessionId: "session-1",
      runId: "run-1",
      thresholdBytes: 64,
      previewBytes: 256,
    });
    const largeOutput = `${"x".repeat(512)}\nFAILURE-MARKER\n`;
    const largeTool: AgentTool = {
      name: "large_output",
      label: "Large Output",
      description: "Return a large deterministic result.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => ({ content: [{ type: "text", text: largeOutput }], details: undefined }),
    };
    const resultId = deriveResultId({
      sessionId: "session-1",
      runId: "run-1",
      toolCallId: "large-call",
      attempt: 0,
    });
    const faux = createFauxCore({});
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("write", { path: "notes/status.txt", content: "hello" }, { id: "write-call" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall(
          "edit",
          { path: "notes/status.txt", edits: [{ oldText: "hello", newText: "hello drive9" }] },
          { id: "edit-call" },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxToolCall("read", { path: "notes/status.txt" }, { id: "read-call" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxToolCall("list", { path: "notes" }, { id: "list-call" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxToolCall("large_output", {}, { id: "large-call" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(
        fauxToolCall("result_search", { resultId, query: "FAILURE-MARKER" }, { id: "search-call" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    let userHookCalls = 0;
    const agent = new Agent(
      integration.withAgentOptions({
        streamFn: faux.streamSimple,
        initialState: {
          systemPrompt: "",
          model: faux.getModel(),
          thinkingLevel: "off",
          tools: [largeTool],
          messages: [],
        },
        afterToolCall: async () => {
          userHookCalls += 1;
          return undefined;
        },
      }),
    );

    await agent.prompt("Use the tools in order.");

    assert.equal(client.text("/workspace/notes/status.txt"), "hello drive9");
    assert.equal(userHookCalls, 6);
    assert.deepEqual(
      agent.state.tools.map((tool) => tool.name),
      ["large_output", "read", "write", "edit", "list", "result_read", "result_search"],
    );
    assert.equal(agent.state.tools.some((tool) => ["bash", "exec"].includes(tool.name)), false);
    const missingShell = await integration.executionEnv.exec("must-not-run");
    assert.equal(missingShell.ok, false);
    if (!missingShell.ok) assert.equal(missingShell.error.code, "shell_unavailable");
    const toolResults = agent.state.messages.filter(
      (message): message is Extract<(typeof agent.state.messages)[number], { role: "toolResult" }> =>
        "role" in message && message.role === "toolResult",
    );
    assert.deepEqual(
      toolResults.map((message) => message.toolName),
      ["write", "edit", "read", "list", "large_output", "result_search"],
    );
    assert.match(toolResultText(toolResults[2]), /hello drive9/);
    assert.match(toolResultText(toolResults[3]), /status\.txt/);
    assert.doesNotMatch(toolResultText(toolResults[4]), new RegExp(`x{100}`));
    assert.match(toolResultText(toolResults[4]), new RegExp(resultId));
    assert.equal((toolResults[4]?.details as CompactToolResultDetails).resultId, resultId);
    assert.match(toolResultText(toolResults[5]), /FAILURE-MARKER/);
    assert.equal(faux.getPendingResponseCount(), 0);

    await integration.cleanup();
  });

  it("binds optional harness tools only to the caller-provided shell", async () => {
    const client = new MemoryDrive9Client();
    const shell = new RecordingShell();
    const integration = createDrive9PiIntegration({
      workspaceClient: client,
      workspaceRoot: "/workspace",
      evidenceClient: client,
      evidenceRoot: "/evidence",
      sessionId: "session-shell",
      runId: "run-shell",
      shell,
      harnessTools: [createBashTool()],
    });
    const faux = createFauxCore({});
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "pwd" }, { id: "bash-call" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    const agent = new Agent(
      integration.withAgentOptions({
        streamFn: faux.streamSimple,
        initialState: { model: faux.getModel() },
      }),
    );

    await agent.prompt("Run the sandbox command.");

    assert.equal(shell.calls.length, 1);
    assert.equal(shell.calls[0]?.command, "pwd");
    assert.equal(shell.calls[0]?.options?.cwd, "/workspace");
    assert.equal(shell.calls[0]?.options?.inheritEnv, true);
    assert.deepEqual(shell.calls[0]?.options?.env, {});
    assert.match(
      toolResultText(agent.state.messages.find((message) => "role" in message && message.role === "toolResult")),
      /sandbox output/,
    );
    await integration.cleanup();
    assert.equal(shell.cleanupCalls, 1);
  });

  it("rejects ambiguous session and tool composition", () => {
    const client = new MemoryDrive9Client();
    const integration = createDrive9PiIntegration({
      workspaceClient: client,
      workspaceRoot: "/workspace",
      evidenceClient: client,
      evidenceRoot: "/evidence",
      sessionId: "session-1",
      runId: "run-1",
    });
    const faux = createFauxCore({});
    const duplicateRead: AgentTool = {
      name: "read",
      label: "Duplicate Read",
      description: "Invalid duplicate.",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "unused" }], details: undefined }),
    };
    const baseOptions = {
      streamFn: faux.streamSimple,
      initialState: { model: faux.getModel(), tools: [duplicateRead] },
    };

    assert.throws(() => integration.withAgentOptions(baseOptions), /already defines a tool named read/);
    assert.throws(
      () => integration.withAgentOptions({ ...baseOptions, initialState: { model: faux.getModel() }, sessionId: "other" }),
      /sessionId must match/,
    );
  });
});
