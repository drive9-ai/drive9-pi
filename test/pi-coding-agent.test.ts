import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { posix } from "node:path";
import { describe, it } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionEvent,
  SlashCommandInfo,
  SourceInfo,
  ToolDefinition,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  createDrive9CodingAgentTools,
  createDrive9PiExtension,
  DRIVE9_STORAGE_ONLY_MESSAGE,
  Drive9FileSystem,
  type Drive9FileEntry,
  type Drive9FileSystemClient,
  type Drive9Stat,
} from "../src/index.js";
import { getDrive9ProjectConfigPath } from "../src/pi-extension-config.js";

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
  description: string;
  parameters: unknown;
  execute: (...args: any[]) => Promise<{
    content: Array<{ type: string; text?: string }>;
  }>;
  renderCall?: (...args: any[]) => unknown;
}

interface RecordedCommand {
  description?: string;
  handler: (args: string, context: ExtensionCommandContext) => Promise<void>;
}

const BOUNDARY_TOOL_NAMES = ["read", "write", "edit", "ls", "bash", "grep", "find"];
const OWN_SOURCE_INFO: SourceInfo = {
  path: "/extensions/drive9-pi.js",
  source: "@drive9/drive9-pi",
  scope: "temporary",
  origin: "top-level",
};
const FOREIGN_SOURCE_INFO: SourceInfo = {
  path: "/extensions/foreign-filesystem.js",
  source: "foreign-filesystem",
  scope: "temporary",
  origin: "top-level",
};

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

  async createFile(path: string): Promise<number> {
    if (this.nodes.has(path)) throw new StatusError(409, `exists: ${path}`);
    this.requireDirectory(posix.dirname(path));
    const node = this.node(new Uint8Array(), false);
    this.nodes.set(path, node);
    return node.revision;
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

interface ExtensionRecorderOptions {
  cwd?: string;
  hasUI?: boolean;
  trusted?: boolean;
  activeTools?: string[];
  conflictingTools?: string[];
}

class ExtensionRecorder {
  readonly handlers = new Map<string, Handler>();
  readonly tools = new Map<string, RecordedTool>();
  readonly commands = new Map<string, RecordedCommand>();
  readonly statuses = new Map<string, string | undefined>();
  readonly notifications: Array<{ message: string; level?: string }> = [];
  readonly flags = new Map<string, boolean | string | undefined>();
  readonly inputResponses: Array<string | undefined> = [];
  readonly confirmResponses: boolean[] = [];
  readonly activeTools: string[];
  readonly extensionErrors: Error[] = [];
  readonly api: ExtensionAPI;
  readonly context: ExtensionContext;
  private readonly effectiveToolOverrides = new Map<string, ToolInfo>();
  private readonly builtinToolParameters = new Map<string, ToolInfo["parameters"]>();
  reloadCount = 0;

  constructor(options: ExtensionRecorderOptions = {}) {
    const cwd = options.cwd ?? process.cwd();
    const hasUI = options.hasUI ?? true;
    const trusted = options.trusted ?? true;
    this.activeTools = [...(options.activeTools ?? ["read", "bash", "edit", "write"])];
    for (const name of BOUNDARY_TOOL_NAMES) {
      this.builtinToolParameters.set(name, {} as ToolInfo["parameters"]);
    }
    for (const name of options.conflictingTools ?? []) this.overrideEffectiveTool(name);
    this.api = {
      on: (event: string, handler: Handler) => this.handlers.set(event, handler),
      registerTool: (tool: ToolDefinition<any, any, any>) =>
        this.tools.set(tool.name, tool as unknown as RecordedTool),
      registerCommand: (name: string, command: RecordedCommand) => this.commands.set(name, command),
      registerFlag: (name: string, flagOptions: { default?: boolean | string }) =>
        this.flags.set(name, flagOptions.default),
      getFlag: (name: string) => this.flags.get(name),
      getAllTools: () => this.getAllTools(),
      getActiveTools: () => [...this.activeTools],
      setActiveTools: (names: string[]) => {
        this.activeTools.splice(0, this.activeTools.length, ...names);
      },
      getCommands: () => this.getCommands(),
    } as unknown as ExtensionAPI;
    this.context = {
      cwd,
      mode: hasUI ? "tui" : "print",
      hasUI,
      isProjectTrusted: () => trusted,
      waitForIdle: async () => {},
      reload: async () => {
        this.reloadCount += 1;
      },
      ui: {
        input: async () => this.inputResponses.shift(),
        confirm: async () => this.confirmResponses.shift() ?? false,
        setStatus: (key: string, value: string | undefined) => this.statuses.set(key, value),
        notify: (message: string, level?: string) =>
          this.notifications.push({ message, ...(level === undefined ? {} : { level }) }),
      },
    } as unknown as ExtensionContext;
  }

  overrideEffectiveTool(name: string): void {
    this.effectiveToolOverrides.set(name, {
      name,
      description: `Foreign ${name} tool`,
      parameters: {} as ToolInfo["parameters"],
      sourceInfo: FOREIGN_SOURCE_INFO,
    });
  }

  private getAllTools(): ToolInfo[] {
    const names = new Set([...BOUNDARY_TOOL_NAMES, ...this.tools.keys()]);
    return [...names].map((name) => {
      const overridden = this.effectiveToolOverrides.get(name);
      if (overridden !== undefined) return overridden;
      const registered = this.tools.get(name);
      if (registered !== undefined) {
        return {
          name,
          description: registered.description,
          parameters: registered.parameters as ToolInfo["parameters"],
          sourceInfo: OWN_SOURCE_INFO,
        };
      }
      return {
        name,
        description: `Built-in ${name} tool`,
        parameters: this.builtinToolParameters.get(name)!,
        sourceInfo: {
          path: `<builtin:${name}>`,
          source: "builtin",
          scope: "temporary",
          origin: "top-level",
        },
      };
    });
  }

  private getCommands(): SlashCommandInfo[] {
    return [...this.commands.entries()].map(([name, command]) => ({
      name,
      ...(command.description === undefined ? {} : { description: command.description }),
      source: "extension",
      sourceInfo: OWN_SOURCE_INFO,
    }));
  }

  async emit(event: string, payload: Record<string, unknown>): Promise<unknown> {
    const handler = this.handlers.get(event);
    assert.ok(handler, `missing ${event} handler`);
    return await handler(payload as unknown as ExtensionEvent, this.context);
  }

  async emitLikePi(event: string, payload: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.emit(event, payload);
    } catch (error) {
      this.extensionErrors.push(error instanceof Error ? error : new Error(String(error)));
      return undefined;
    }
  }

  async command(name: string, args = ""): Promise<void> {
    const command = this.commands.get(name);
    assert.ok(command, `missing /${name} command`);
    await command.handler(args, this.context as ExtensionCommandContext);
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

async function selectedToolExecutionCallRenderer(
  tool: RecordedTool,
  cwd: string,
): Promise<unknown> {
  initTheme(undefined, false);
  const codingAgentUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
  const componentUrl = new URL("./modes/interactive/components/tool-execution.js", codingAgentUrl);
  const { ToolExecutionComponent } = await import(componentUrl.href);
  const component = new ToolExecutionComponent(
    tool.name,
    "tool-call",
    { path: "src/value.ts", edits: [{ oldText: "value = 1", newText: "value = 2" }] },
    undefined,
    tool,
    { requestRender() {} },
    cwd,
  );
  return (component as unknown as { getCallRenderer(): unknown }).getCallRenderer();
}

describe("Pi coding-agent filesystem integration", () => {
  it("uses Pi's canonical read/write/edit/ls tools without touching the host filesystem", async () => {
    const hostRoot = await mkdtemp(posix.join(tmpdir(), "drive9-pi-canonical-"));
    const hostPath = posix.join(hostRoot, "src/value.ts");
    await mkdir(posix.dirname(hostPath), { recursive: true });
    await writeFile(hostPath, "host file must remain unchanged\n");
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
      const editTool = tools.get("edit")!;
      assert.equal(typeof editTool.renderCall, "function");
      assert.equal(await selectedToolExecutionCallRenderer(editTool, hostRoot), editTool.renderCall);

      await toolText(tools.get("write")!, { path: "src/value.ts", content: "export const value = 1;\n" });
      await toolText(tools.get("edit")!, {
        path: "src/value.ts",
        edits: [{ oldText: "value = 1", newText: "value = 2" }],
      });

      assert.equal(client.text(posix.join(hostRoot, "src/value.ts")), "export const value = 2;\n");
      assert.match(await toolText(tools.get("read")!, { path: "src/value.ts" }), /value = 2/);
      assert.equal(await toolText(tools.get("ls")!, { path: "." }), "src/");
      assert.equal(await readFile(hostPath, "utf8"), "host file must remain unchanged\n");
      await assert.rejects(toolText(tools.get("bash")!, { command: "pwd" }), /does not provide bash/);
    } finally {
      await fileSystem.cleanup();
      await rm(hostRoot, { recursive: true, force: true });
    }
  });

  it("loads as a Pi package extension and blocks split-world process tools", async () => {
    const client = new MemoryWorkspaceClient("/workspace");
    const recorder = new ExtensionRecorder({
      activeTools: ["read", "bash", "edit", "write", "memory", "grep"],
    });
    createDrive9PiExtension({ defaultRoot: "/workspace", createClient: () => client })(recorder.api);

    await recorder.emit("session_start", { type: "session_start", reason: "startup" });
    assert.deepEqual([...recorder.tools.keys()], ["read", "write", "edit", "ls"]);
    assert.deepEqual(recorder.activeTools, ["memory", "read", "edit", "write", "ls"]);
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

    await recorder.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
    assert.deepEqual(recorder.activeTools, ["memory", "read", "bash", "edit", "write", "grep"]);
  });

  it("preserves explicit active-tool restrictions while adding ls for the default filesystem set", async () => {
    const cases = [
      { active: [] as string[], expected: [] as string[] },
      { active: ["read"], expected: ["read"] },
      {
        active: ["read", "bash", "edit", "write"],
        expected: ["read", "edit", "write", "ls"],
      },
    ];

    for (const testCase of cases) {
      const client = new MemoryWorkspaceClient("/workspace");
      const recorder = new ExtensionRecorder({ activeTools: testCase.active });
      createDrive9PiExtension({ defaultRoot: "/workspace", createClient: () => client })(recorder.api);

      await recorder.emit("session_start", { type: "session_start", reason: "startup" });

      assert.deepEqual(recorder.activeTools, testCase.expected);
      assert.equal(recorder.statuses.get("drive9"), "Drive9: /workspace");
    }
  });

  it("supports the standard setup, status, verify, and disable workflow", async () => {
    const cwd = await mkdtemp(posix.join(tmpdir(), "drive9-pi-extension-"));
    const suggestedRoot = `/workspaces/${posix.basename(cwd)}`;
    const client = new MemoryWorkspaceClient("/");
    const extensionOptions = {
      createClient: () => client,
      environment: {},
    };

    try {
      const setup = new ExtensionRecorder({ cwd });
      setup.inputResponses.push("");
      setup.confirmResponses.push(true, true);
      createDrive9PiExtension(extensionOptions)(setup.api);
      await setup.emit("session_start", { type: "session_start", reason: "startup" });
      assert.ok(setup.commands.has("drive9"));
      assert.equal(setup.tools.size, 0);

      await setup.command("drive9", "status");
      assert.match(setup.notifications.at(-1)?.message ?? "", /Drive9: inactive/);
      await setup.command("drive9", "setup");
      assert.equal(setup.reloadCount, 1);
      assert.equal(client.nodes.get("/workspaces")?.isDir, true);
      assert.equal(client.nodes.get(suggestedRoot)?.isDir, true);

      const configPath = getDrive9ProjectConfigPath(cwd);
      assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
        version: 1,
        enabled: true,
        root: suggestedRoot,
      });

      const active = new ExtensionRecorder({ cwd });
      createDrive9PiExtension(extensionOptions)(active.api);
      await active.emit("session_start", { type: "session_start", reason: "startup" });
      assert.equal(active.statuses.get("drive9"), `Drive9: ${suggestedRoot}`);
      await active.command("drive9", "status");
      assert.match(active.notifications.at(-1)?.message ?? "", /Drive9: active/);
      assert.match(active.notifications.at(-1)?.message ?? "", /read, write, edit, ls -> Drive9/);
      assert.match(active.notifications.at(-1)?.message ?? "", /Pi project trust: trusted/);
      assert.match(active.notifications.at(-1)?.message ?? "", /\.pi\/settings\.json/);
      assert.match(active.notifications.at(-1)?.message ?? "", /Interactive !:.*interceptor load order/);

      await active.command("drive9", "verify write");
      assert.match(active.notifications.at(-1)?.message ?? "", /write verification succeeded/);
      assert.equal([...client.nodes.keys()].some((path) => path.includes("verify-")), false);

      active.confirmResponses.push(true);
      await active.command("drive9", "disable");
      assert.equal(active.reloadCount, 1);
      assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
        version: 1,
        enabled: false,
        root: suggestedRoot,
      });

      const disabled = new ExtensionRecorder({ cwd });
      createDrive9PiExtension(extensionOptions)(disabled.api);
      await disabled.emit("session_start", { type: "session_start", reason: "startup" });
      assert.equal(disabled.tools.size, 0);
      assert.equal(disabled.statuses.get("drive9"), "Drive9: off");
      await active.emit("session_shutdown", { type: "session_shutdown" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("leaves project configuration unchanged when a workspace parent is a file", async () => {
    const cwd = await mkdtemp(posix.join(tmpdir(), "drive9-pi-extension-file-parent-"));
    const client = new MemoryWorkspaceClient("/");
    await client.write("/workspaces", Buffer.from("not a directory"));

    try {
      const setup = new ExtensionRecorder({ cwd });
      setup.confirmResponses.push(true);
      createDrive9PiExtension({ createClient: () => client, environment: {} })(setup.api);
      await setup.emit("session_start", { type: "session_start", reason: "startup" });
      await setup.command("drive9", "setup /workspaces/project");

      assert.equal(setup.reloadCount, 0);
      assert.equal(client.nodes.has("/workspaces/project"), false);
      assert.match(setup.notifications.at(-1)?.message ?? "", /path component is not a directory/);
      await assert.rejects(readFile(getDrive9ProjectConfigPath(cwd), "utf8"), /ENOENT/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
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
    assert.deepEqual([...failed.tools.keys()], ["read", "write", "edit", "ls"]);
    assert.deepEqual(failed.activeTools, []);
    assert.equal(failed.notifications.length, 1);
    await assert.rejects(toolText(failed.tools.get("read")!, { path: "secret" }), /tenant root/);

    const headless = new ExtensionRecorder({
      hasUI: false,
      activeTools: ["read", "bash", "edit", "write", "memory"],
    });
    createDrive9PiExtension({
      defaultRoot: "/",
      createClient: () => new MemoryWorkspaceClient("/"),
      environment: {},
    })(headless.api);
    await headless.emitLikePi("session_start", { type: "session_start", reason: "startup" });
    assert.equal(headless.extensionErrors.length, 1);
    assert.match(headless.extensionErrors[0]?.message ?? "", /DRIVE9_INIT_FAILED/);
    assert.deepEqual([...headless.tools.keys()], ["read", "write", "edit", "ls"]);
    assert.deepEqual(headless.activeTools, ["memory"]);
    for (const toolName of BOUNDARY_TOOL_NAMES) {
      const result = await headless.emit("tool_call", {
        type: "tool_call",
        toolCallId: `headless-${toolName}`,
        toolName,
        input: {},
      });
      assert.equal((result as { block?: boolean } | undefined)?.block, true);
    }
    const prompt = (await headless.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "inspect",
      systemPrompt: `Current working directory: ${process.cwd()}`,
      systemPromptOptions: { cwd: process.cwd() },
    })) as { systemPrompt: string };
    assert.match(prompt.systemPrompt, /Standard filesystem and process tools are blocked/);
    assert.match(prompt.systemPrompt, /DRIVE9_INIT_FAILED/);
  });

  it("fails closed instead of claiming active when another extension owns a filesystem tool", async () => {
    const client = new MemoryWorkspaceClient("/workspace");
    const recorder = new ExtensionRecorder({
      activeTools: ["read", "bash", "edit", "write", "memory"],
      conflictingTools: ["read"],
    });
    createDrive9PiExtension({ defaultRoot: "/workspace", createClient: () => client })(recorder.api);

    await recorder.emit("session_start", { type: "session_start", reason: "startup" });

    assert.equal(recorder.statuses.get("drive9"), "Drive9: unavailable");
    assert.deepEqual(recorder.activeTools, ["memory"]);
    assert.match(recorder.notifications.at(-1)?.message ?? "", /does not own the effective read tool/);
    const blocked = await recorder.emit("tool_call", {
      type: "tool_call",
      toolCallId: "conflicting-read",
      toolName: "read",
      input: {},
    });
    assert.deepEqual(blocked, {
      block: true,
      reason: recorder.notifications.at(-1)?.message,
    });
  });

  it("detects runtime filesystem ownership drift and keeps local fallback blocked", async () => {
    const client = new MemoryWorkspaceClient("/workspace");
    const recorder = new ExtensionRecorder({
      activeTools: ["read", "bash", "edit", "write", "memory"],
    });
    createDrive9PiExtension({ defaultRoot: "/workspace", createClient: () => client })(recorder.api);
    await recorder.emit("session_start", { type: "session_start", reason: "startup" });
    assert.equal(recorder.statuses.get("drive9"), "Drive9: /workspace");

    recorder.overrideEffectiveTool("write");
    const blocked = await recorder.emit("tool_call", {
      type: "tool_call",
      toolCallId: "drifted-write",
      toolName: "write",
      input: { path: "host.txt", content: "must not be written" },
    });

    assert.equal((blocked as { block?: boolean } | undefined)?.block, true);
    assert.match((blocked as { reason?: string } | undefined)?.reason ?? "", /lost ownership/);
    assert.equal(recorder.statuses.get("drive9"), "Drive9: unavailable");
    assert.deepEqual(recorder.activeTools, ["memory"]);
    const prompt = (await recorder.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "inspect",
      systemPrompt: `Current working directory: ${process.cwd()}`,
      systemPromptOptions: { cwd: process.cwd() },
    })) as { systemPrompt: string };
    assert.match(prompt.systemPrompt, /do not access or modify the host filesystem/);
  });
});
