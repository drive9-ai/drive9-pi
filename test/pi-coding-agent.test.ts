import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { posix } from "node:path";
import { describe, it } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createDrive9CodingAgentTools,
  createDrive9PiExtension,
  DRIVE9_STORAGE_ONLY_MESSAGE,
  Drive9FileSystem,
  type Drive9FileEntry,
  type Drive9FileSystemClient,
  type Drive9Stat,
} from "../src/index.js";

class StatusError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

interface MemoryNode {
  data: Uint8Array;
  isDir: boolean;
  revision: number;
}

interface RecordedTool {
  name: string;
  execute: (...args: any[]) => Promise<{
    content: Array<{ type: string; text?: string }>;
  }>;
  renderCall?: unknown;
}

class MemoryWorkspaceClient implements Drive9FileSystemClient {
  readonly nodes = new Map<string, MemoryNode>();
  private revision = 1;

  constructor(root: string) {
    this.nodes.set(root, this.node(new Uint8Array(), true));
  }

  text(path: string): string {
    return Buffer.from(this.require(path).data).toString("utf8");
  }

  async read(path: string): Promise<Uint8Array> {
    const node = this.require(path);
    if (node.isDir) throw new StatusError(400, `is a directory: ${path}`);
    return Uint8Array.from(node.data);
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    this.requireDirectory(posix.dirname(path));
    this.nodes.set(path, this.node(data, false));
  }

  async append(path: string, data: Uint8Array): Promise<void> {
    const existing = this.nodes.get(path)?.data ?? new Uint8Array();
    const combined = new Uint8Array(existing.byteLength + data.byteLength);
    combined.set(existing);
    combined.set(data, existing.byteLength);
    await this.write(path, combined);
  }

  async list(path: string): Promise<Drive9FileEntry[]> {
    this.requireDirectory(path);
    return [...this.nodes.entries()]
      .filter(([candidate]) => candidate !== path && posix.dirname(candidate) === path)
      .map(([candidate, node]) => ({
        name: posix.basename(candidate),
        size: node.data.byteLength,
        isDir: node.isDir,
        mode: node.isDir ? 0o40755 : 0o100644,
      }));
  }

  async stat(path: string): Promise<Drive9Stat> {
    const node = this.require(path);
    return {
      size: node.data.byteLength,
      isDir: node.isDir,
      revision: node.revision,
      mode: node.isDir ? 0o40755 : 0o100644,
    };
  }

  async rename(sourcePath: string, destinationPath: string): Promise<void> {
    const node = this.require(sourcePath);
    this.requireDirectory(posix.dirname(destinationPath));
    this.nodes.delete(sourcePath);
    this.nodes.set(destinationPath, node);
  }

  async mkdir(path: string): Promise<void> {
    if (this.nodes.has(path)) throw new StatusError(409, `exists: ${path}`);
    this.requireDirectory(posix.dirname(path));
    this.nodes.set(path, this.node(new Uint8Array(), true));
  }

  async deleteFile(path: string): Promise<void> {
    const node = this.require(path);
    if (node.isDir) throw new StatusError(400, `is a directory: ${path}`);
    this.nodes.delete(path);
  }

  async deleteDir(path: string): Promise<void> {
    this.requireDirectory(path);
    this.nodes.delete(path);
  }

  async removeAll(path: string): Promise<void> {
    for (const candidate of [...this.nodes.keys()]) {
      if (candidate === path || candidate.startsWith(`${path}/`)) this.nodes.delete(candidate);
    }
  }

  private node(data: Uint8Array, isDir: boolean): MemoryNode {
    return { data: Uint8Array.from(data), isDir, revision: this.revision++ };
  }

  private require(path: string): MemoryNode {
    const node = this.nodes.get(path);
    if (node === undefined) throw new StatusError(404, `not found: ${path}`);
    return node;
  }

  private requireDirectory(path: string): MemoryNode {
    const node = this.require(path);
    if (!node.isDir) throw new StatusError(400, `not a directory: ${path}`);
    return node;
  }
}

type Handler = (event: ExtensionEvent, context: ExtensionContext) => unknown | Promise<unknown>;

class ExtensionRecorder {
  readonly handlers = new Map<string, Handler>();
  readonly tools = new Map<string, RecordedTool>();
  readonly statuses = new Map<string, string | undefined>();
  readonly notifications: Array<{ message: string; level?: string }> = [];
  readonly flags = new Map<string, boolean | string | undefined>();

  readonly api = {
    on: (event: string, handler: Handler) => this.handlers.set(event, handler),
    registerTool: (tool: ToolDefinition<any, any, any>) =>
      this.tools.set(tool.name, tool as unknown as RecordedTool),
    registerFlag: (name: string, options: { default?: boolean | string }) => this.flags.set(name, options.default),
    getFlag: (name: string) => this.flags.get(name),
  } as unknown as ExtensionAPI;

  readonly context = {
    ui: {
      setStatus: (key: string, value: string | undefined) => this.statuses.set(key, value),
      notify: (message: string, level?: string) =>
        this.notifications.push({ message, ...(level === undefined ? {} : { level }) }),
    },
  } as unknown as ExtensionContext;

  async emit(event: string, payload: Record<string, unknown>): Promise<unknown> {
    const handler = this.handlers.get(event);
    assert.ok(handler, `missing ${event} handler`);
    return await handler(payload as unknown as ExtensionEvent, this.context);
  }
}

async function toolText(
  tool: RecordedTool,
  input: Record<string, unknown>,
): Promise<string> {
  const result = await tool.execute("tool-call", input, undefined, undefined, undefined as never);
  return result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

describe("Pi coding-agent filesystem integration", () => {
  it("uses Pi's canonical read/write/edit/ls tools without touching the host filesystem", async () => {
    const hostRoot = await mkdtemp(posix.join(tmpdir(), "drive9-pi-canonical-"));
    const client = new MemoryWorkspaceClient(hostRoot);
    const fileSystem = new Drive9FileSystem({ client, root: hostRoot });
    const tools = new Map(
      createDrive9CodingAgentTools({ fileSystem }).map((tool) => [
        tool.name,
        tool as unknown as RecordedTool,
      ]),
    );

    try {
      assert.deepEqual([...tools.keys()], ["read", "write", "edit", "ls", "bash"]);
      assert.equal("renderCall" in (tools.get("edit") ?? {}), false);

      await toolText(tools.get("write")!, { path: "src/value.ts", content: "export const value = 1;\n" });
      await toolText(tools.get("edit")!, {
        path: "src/value.ts",
        edits: [{ oldText: "value = 1", newText: "value = 2" }],
      });

      assert.equal(client.text(posix.join(hostRoot, "src/value.ts")), "export const value = 2;\n");
      assert.match(await toolText(tools.get("read")!, { path: "src/value.ts" }), /value = 2/);
      assert.equal(await toolText(tools.get("ls")!, { path: "." }), "src/");
      await assert.rejects(access(posix.join(hostRoot, "src/value.ts")));
      await assert.rejects(toolText(tools.get("bash")!, { command: "pwd" }), /does not provide bash/);
    } finally {
      await fileSystem.cleanup();
      await rm(hostRoot, { recursive: true, force: true });
    }
  });

  it("loads as a Pi package extension and blocks split-world process tools", async () => {
    const client = new MemoryWorkspaceClient("/workspace");
    const recorder = new ExtensionRecorder();
    createDrive9PiExtension({ defaultRoot: "/workspace", createClient: () => client })(recorder.api);

    await recorder.emit("session_start", { type: "session_start", reason: "startup" });
    assert.deepEqual([...recorder.tools.keys()], ["read", "write", "edit", "ls", "bash"]);
    assert.equal(recorder.statuses.get("drive9"), "Drive9: /workspace");

    await toolText(recorder.tools.get("write")!, { path: "hello.txt", content: "hello" });
    assert.equal(client.text("/workspace/hello.txt"), "hello");

    for (const toolName of ["bash", "grep", "find"]) {
      const result = await recorder.emit("tool_call", {
        type: "tool_call",
        toolCallId: `call-${toolName}`,
        toolName,
        input: {},
      });
      assert.deepEqual(result, { block: true, reason: DRIVE9_STORAGE_ONLY_MESSAGE });
    }

    const userBash = (await recorder.emit("user_bash", {
      type: "user_bash",
      command: "pwd",
      excludeFromContext: false,
      cwd: process.cwd(),
    })) as { operations: { exec: () => Promise<unknown> } };
    await assert.rejects(userBash.operations.exec(), /does not provide bash/);

    const prompt = (await recorder.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "inspect",
      systemPrompt: `Current working directory: ${process.cwd()}`,
      systemPromptOptions: { cwd: process.cwd() },
    })) as { systemPrompt: string };
    assert.match(prompt.systemPrompt, /Current working directory: \/workspace \(Drive9 SDK workspace\)/);
    assert.match(prompt.systemPrompt, /Use read, write, edit, and ls/);
  });

  it("stays inert without a Drive9 root and fails closed when initialization fails", async () => {
    const inert = new ExtensionRecorder();
    createDrive9PiExtension({ defaultRoot: "" })(inert.api);
    await inert.emit("session_start", { type: "session_start", reason: "startup" });
    assert.equal(inert.tools.size, 0);
    assert.equal(
      await inert.emit("tool_call", { type: "tool_call", toolCallId: "bash", toolName: "bash", input: {} }),
      undefined,
    );

    const failed = new ExtensionRecorder();
    createDrive9PiExtension({ defaultRoot: "/", createClient: () => new MemoryWorkspaceClient("/") })(failed.api);
    await failed.emit("session_start", { type: "session_start", reason: "startup" });
    assert.deepEqual([...failed.tools.keys()], ["read", "write", "edit", "ls", "bash"]);
    assert.equal(failed.notifications.length, 1);
    await assert.rejects(toolText(failed.tools.get("read")!, { path: "secret" }), /tenant root/);
  });
});
