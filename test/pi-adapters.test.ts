import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import type { AfterToolCallContext, ExecutionEnv } from "@earendil-works/pi-agent-core";
import {
  createAfterToolCallFallback,
  createDrive9ExecTool,
  createResultReadTool,
  createResultSearchTool,
  type ToolResultIdentityAllocator,
} from "../src/pi-adapters.js";
import { Drive9ExecutionEnv } from "../src/drive9-execution-env.js";
import {
  createPrivateCommandEnvironment,
  createTrustedHelperEnvironment,
} from "../src/private-command-environment.js";
import { PersistentToolResultStore } from "../src/tool-result-store.js";
import {
  ResultStoreError,
  type ResultStoreBackend,
  type ResultStoreObject,
  type ToolResultIdentity,
} from "../src/tool-result-types.js";

class MemoryBackend implements ResultStoreBackend {
  readonly objects = new Map<string, ResultStoreObject>();
  private revision = 0;

  async create(path: string, data: Uint8Array): Promise<{ revision: number }> {
    if (this.objects.has(path)) throw new ResultStoreError("conflict", "exists");
    const revision = ++this.revision;
    this.objects.set(path, { data: Uint8Array.from(data), revision });
    return { revision };
  }

  async read(path: string): Promise<ResultStoreObject> {
    const object = this.objects.get(path);
    if (object === undefined) throw new ResultStoreError("not_found", "missing");
    return { data: Uint8Array.from(object.data), revision: object.revision };
  }

  async replace(path: string, data: Uint8Array, expectedRevision: number): Promise<{ revision: number }> {
    const object = this.objects.get(path);
    if (object === undefined) throw new ResultStoreError("not_found", "missing");
    if (object.revision !== expectedRevision) throw new ResultStoreError("conflict", "revision mismatch");
    const revision = ++this.revision;
    this.objects.set(path, { data: Uint8Array.from(data), revision });
    return { revision };
  }
}

class FinalizeFailBackend extends MemoryBackend {
  override async replace(path: string, data: Uint8Array, expectedRevision: number): Promise<{ revision: number }> {
    const value = JSON.parse(Buffer.from(data).toString("utf8")) as { state?: string };
    if (path.endsWith("/manifest.json") && value.state === "completed") {
      throw new ResultStoreError("unavailable", "finalize failed");
    }
    return await super.replace(path, data, expectedRevision);
  }
}

const execFileAsync = promisify(execFile);

function identity(attempt: number, sessionId = "session-1", toolCallId = "call-1"): ToolResultIdentity {
  return { sessionId, runId: "run-1", toolCallId, attempt };
}

function allocatorFor(...identities: ToolResultIdentity[]): ToolResultIdentityAllocator {
  let position = 0;
  return async () => {
    const selected = identities[position];
    if (selected === undefined) throw new Error("identity allocator exhausted");
    position += 1;
    return selected;
  };
}

function executionEnv(
  execute: (
    command: string,
    options?: {
      abortSignal?: AbortSignal;
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
    },
  ) => Promise<
    | { ok: true; value: { stdout: string; stderr: string; exitCode: number } }
    | { ok: false; error: { code: "aborted" | "timeout" | "unknown"; message: string } }
  >,
): ExecutionEnv {
  return { exec: execute } as unknown as ExecutionEnv;
}

async function persistText(
  store: PersistentToolResultStore,
  resultIdentity: ToolResultIdentity,
  text: string,
  state: "completed" | "failed" = "completed",
  toolName = "fixture",
): Promise<string> {
  const begun = await store.begin({
    identity: resultIdentity,
    toolName,
    mediaType: "text/plain; charset=utf-8",
  });
  assert.equal(begun.kind, "writing");
  if (begun.kind !== "writing") throw new Error("unexpected terminal result");
  await begun.writer.append({ seq: 0, stream: "tool", data: Buffer.from(text) });
  const stat = await begun.writer.finalize({ state, chunkCount: 1 });
  return stat.resultId;
}

function fallbackContext(text: string, isError = false): AfterToolCallContext {
  return {
    assistantMessage: {} as AfterToolCallContext["assistantMessage"],
    toolCall: { type: "toolCall", id: "call-1", name: "fixture", arguments: {} },
    args: {},
    result: { content: [{ type: "text", text }], details: { original: true } },
    isError,
    context: { systemPrompt: "", messages: [] },
  };
}

describe("Pi durable result adapters", () => {
  it("rejects ambient host environment inheritance for model commands", () => {
    const store = new PersistentToolResultStore({ backend: new MemoryBackend() });
    assert.throws(
      () =>
        createDrive9ExecTool({
          env: executionEnv(async () => ({ ok: true, value: { stdout: "", stderr: "", exitCode: 0 } })),
          store,
          allocateIdentity: allocatorFor(identity(0)),
          inheritEnvironment: true,
        }),
      (error: unknown) => error instanceof ResultStoreError && error.code === "invalid",
    );
  });

  it("marks a pre-existing drive9_exec attempt unknown and spawns only a fresh attempt", async () => {
    const store = new PersistentToolResultStore({ backend: new MemoryBackend() });
    const old = await store.begin({
      identity: identity(0),
      toolName: "drive9_exec",
      mediaType: "text/plain; charset=utf-8",
    });
    assert.equal(old.kind, "writing");
    let executions = 0;
    const tool = createDrive9ExecTool({
      env: executionEnv(async (_command, options) => {
        executions += 1;
        options?.onStdout?.("fresh output\n");
        return { ok: true, value: { stdout: "fresh output\n", stderr: "", exitCode: 0 } };
      }),
      store,
      allocateIdentity: allocatorFor(identity(0), identity(1)),
    });
    const result = await tool.execute("call-1", { command: "printf fresh" });
    assert.equal(executions, 1);
    assert.equal((await store.stat(old.kind === "writing" ? old.writer.resultId : "")).state, "unknown");
    assert.equal(result.details.state, "completed");
    assert.equal(result.details.chunkCount, 1);
    assert.ok(Buffer.byteLength(result.content[0]?.type === "text" ? result.content[0].text : "", "utf8") <= 8192);
  });

  it("returns an existing terminal result without spawning", async () => {
    const store = new PersistentToolResultStore({ backend: new MemoryBackend() });
    const resultId = await persistText(store, identity(0), "already durable\n", "completed", "drive9_exec");
    let executions = 0;
    const tool = createDrive9ExecTool({
      env: executionEnv(async () => {
        executions += 1;
        return { ok: true, value: { stdout: "", stderr: "", exitCode: 0 } };
      }),
      store,
      allocateIdentity: allocatorFor(identity(0)),
    });
    const result = await tool.execute("call-1", { command: "should-not-run" });
    assert.equal(executions, 0);
    assert.equal(result.details.resultId, resultId);
    assert.equal(result.details.state, "completed");
  });

  it("reserves callback order, chunks output, and returns only a compact reference", async () => {
    const store = new PersistentToolResultStore({ backend: new MemoryBackend() });
    const stdout = "a".repeat(70 * 1024);
    const stderr = "\nlate failure: fixture\n";
    const tool = createDrive9ExecTool({
      env: executionEnv(async (_command, options) => {
        options?.onStdout?.(stdout);
        options?.onStderr?.(stderr);
        return { ok: true, value: { stdout, stderr, exitCode: 0 } };
      }),
      store,
      allocateIdentity: allocatorFor(identity(0)),
    });
    const result = await tool.execute("call-1", { command: "npm test" });
    assert.equal(result.details.state, "completed");
    assert.equal(result.details.chunkCount, 3);
    assert.equal(result.details.totalBytes, Buffer.byteLength(stdout + stderr));
    const stored = await store.readRange(result.details.resultId, {
      offset: 0,
      length: 64 * 1024,
    });
    const remainder = await store.readRange(result.details.resultId, {
      offset: stored.nextOffset ?? stored.endByte,
      length: 64 * 1024,
    });
    assert.equal(Buffer.concat([Buffer.from(stored.bytes), Buffer.from(remainder.bytes)]).toString(), stdout + stderr);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    assert.ok(Buffer.byteLength(text, "utf8") <= 8 * 1024);
    assert.ok(Buffer.byteLength(text, "utf8") < result.details.totalBytes);
  });

  it("ignores output callbacks after execution settles", async () => {
    const store = new PersistentToolResultStore({ backend: new MemoryBackend() });
    const tool = createDrive9ExecTool({
      env: executionEnv(async (_command, options) => {
        options?.onStdout?.("before\n");
        setTimeout(() => options?.onStdout?.("late\n"), 0);
        return { ok: true, value: { stdout: "before\n", stderr: "", exitCode: 0 } };
      }),
      store,
      allocateIdentity: allocatorFor(identity(0)),
    });
    const result = await tool.execute("call-1", { command: "late-callback" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stored = await store.readRange(result.details.resultId, { offset: 0, length: 64 * 1024 });
    assert.equal(Buffer.from(stored.bytes).toString(), "before\n");
    assert.equal((await store.stat(result.details.resultId)).chunkCount, 1);
  });

  it("keeps host HOME, XDG, and Drive9 credentials out of the command process", async () => {
    const hostHome = await mkdtemp(join(tmpdir(), "drive9-pi-host-home-"));
    const hostXdg = await mkdtemp(join(tmpdir(), "drive9-pi-host-xdg-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "drive9-pi-workspace-"));
    const privateHome = join(workspaceRoot, "private-home");
    await mkdir(join(hostHome, ".drive9"), { recursive: true });
    await mkdir(join(hostXdg, "drive9"), { recursive: true });
    await mkdir(privateHome, { recursive: true });
    await writeFile(join(hostHome, ".drive9", "config"), "host-home-sentinel");
    await writeFile(join(hostXdg, "drive9", "config"), "host-xdg-sentinel");

    const previous = {
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      DRIVE9_API_KEY: process.env.DRIVE9_API_KEY,
      DRIVE9_SERVER: process.env.DRIVE9_SERVER,
    };
    process.env.HOME = hostHome;
    process.env.XDG_CONFIG_HOME = hostXdg;
    process.env.DRIVE9_API_KEY = "host-api-key-sentinel";
    process.env.DRIVE9_SERVER = "host-server-sentinel";

    const env = new Drive9ExecutionEnv({ workspaceRoot });
    try {
      const store = new PersistentToolResultStore({ backend: new MemoryBackend() });
      const commandEnvironment = createPrivateCommandEnvironment({
        home: privateHome,
        path: `${dirname(process.execPath)}:/usr/bin:/bin`,
      });
      const script = `
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.HOME || "";
const xdg = process.env.XDG_CONFIG_HOME || "";
process.stdout.write(JSON.stringify({
  home,
  xdg,
  apiKey: process.env.DRIVE9_API_KEY,
  server: process.env.DRIVE9_SERVER,
  homeSentinel: fs.existsSync(path.join(home, ".drive9", "config")),
  xdgSentinel: fs.existsSync(path.join(xdg, "drive9", "config")),
}));
`;
      const scriptPath = join(workspaceRoot, "sentinel-check.cjs");
      await writeFile(scriptPath, script);
      const tool = createDrive9ExecTool({
        env,
        store,
        allocateIdentity: allocatorFor(identity(0)),
        commandEnvironment,
      });
      const result = await tool.execute("call-1", {
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`,
      });
      assert.equal(result.details.state, "completed");
      const stored = await store.readRange(result.details.resultId, { offset: 0, length: 64 * 1024 });
      const observed = JSON.parse(Buffer.from(stored.bytes).toString("utf8")) as Record<string, unknown>;
      assert.equal(observed.home, privateHome);
      assert.equal(observed.xdg, join(privateHome, ".config"));
      assert.equal(observed.apiKey, undefined);
      assert.equal(observed.server, undefined);
      assert.equal(observed.homeSentinel, false);
      assert.equal(observed.xdgSentinel, false);
      await assert.rejects(async () => await readFile(join(privateHome, ".drive9", "config")));

      const helper = await execFileAsync(process.execPath, [scriptPath], {
        env: createTrustedHelperEnvironment(commandEnvironment),
      });
      const helperObserved = JSON.parse(helper.stdout) as Record<string, unknown>;
      assert.equal(helperObserved.home, privateHome);
      assert.equal(helperObserved.xdg, join(privateHome, ".config"));
      assert.equal(helperObserved.apiKey, undefined);
      assert.equal(helperObserved.server, undefined);
      assert.equal(helperObserved.homeSentinel, false);
      assert.equal(helperObserved.xdgSentinel, false);
    } finally {
      await env.cleanup();
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("aborts on bounded pending output and never reports completed evidence", async () => {
    const store = new PersistentToolResultStore({ backend: new MemoryBackend() });
    const tool = createDrive9ExecTool({
      env: executionEnv(async (_command, options) => {
        options?.onStdout?.("a".repeat(128 * 1024));
        assert.equal(options?.abortSignal?.aborted, true);
        return { ok: false, error: { code: "aborted", message: "aborted" } };
      }),
      store,
      allocateIdentity: allocatorFor(identity(0)),
      maxPendingBytes: 64 * 1024,
    });
    const result = await tool.execute("call-1", { command: "too-loud" });
    assert.equal(result.details.state, "aborted");
    assert.notEqual(result.details.state, "completed");
    assert.notEqual(result.details.error?.code, undefined);
  });

  it("fails closed when durable finalization fails instead of emitting a completed reference", async () => {
    const store = new PersistentToolResultStore({ backend: new FinalizeFailBackend() });
    const tool = createDrive9ExecTool({
      env: executionEnv(async (_command, options) => {
        options?.onStdout?.("durable output\n");
        return { ok: true, value: { stdout: "durable output\n", stderr: "", exitCode: 0 } };
      }),
      store,
      allocateIdentity: allocatorFor(identity(0)),
    });
    await assert.rejects(
      async () => await tool.execute("call-1", { command: "printf durable" }),
      (error: unknown) => error instanceof ResultStoreError && error.code === "unavailable",
    );
    const existing = await store.begin({
      identity: identity(0),
      toolName: "drive9_exec",
      mediaType: "text/plain; charset=utf-8",
    });
    assert.equal(existing.kind, "writing");
    if (existing.kind !== "writing") throw new Error("failed finalization became terminal");
    assert.equal((await store.stat(existing.writer.resultId)).state, "writing");
  });

  it("offloads only oversized all-text fallback results and resumes deterministic chunks", async () => {
    const store = new PersistentToolResultStore({ backend: new MemoryBackend() });
    const text = `${"x".repeat(60 * 1024)}\nknown-late-failure\n`;
    const fallback = createAfterToolCallFallback({
      store,
      allocateIdentity: allocatorFor(identity(0), identity(0)),
    });
    assert.equal(await fallback(fallbackContext("small")), undefined);
    const overridden = await fallback(fallbackContext(text));
    assert.notEqual(overridden, undefined);
    const details = overridden?.details as { resultId: string; totalBytes: number };
    assert.equal(details.totalBytes, Buffer.byteLength(text));
    const read = await store.readRange(details.resultId, { offset: 0, length: 64 * 1024 });
    assert.equal(Buffer.from(read.bytes).toString(), text);
    assert.ok(Buffer.byteLength(overridden?.content?.[0]?.type === "text" ? overridden.content[0].text : "") <= 8192);
    const repeated = await fallback(fallbackContext(text));
    assert.equal((repeated?.details as { resultId: string }).resultId, details.resultId);
  });

  it("keeps result_read and result_search bounded and rejects cross-session access", async () => {
    const store = new PersistentToolResultStore({ backend: new MemoryBackend() });
    const text = `${Array.from({ length: 300 }, (_, index) => `line-${index}`).join("\n")}\nlate-failure-marker\n`;
    const resultId = await persistText(store, identity(0, "session-a"), text);
    const deniedRead = createResultReadTool({ store, currentSessionId: () => "session-b" });
    await assert.rejects(
      async () => await deniedRead.execute("read-1", { resultId }),
      (error: unknown) => error instanceof ResultStoreError && error.code === "permission_denied",
    );

    const readTool = createResultReadTool({ store, currentSessionId: () => "session-a" });
    const first = await readTool.execute("read-1", { resultId, maxLines: 10, maxBytes: 4096 });
    const firstDetails = first.details as { nextCursor?: string; endLine: number };
    assert.equal(firstDetails.endLine, 10);
    assert.notEqual(firstDetails.nextCursor, undefined);
    const cursor = firstDetails.nextCursor;
    if (cursor === undefined) throw new Error("missing read cursor");
    const second = await readTool.execute("read-2", { resultId, cursor, maxLines: 10 });
    assert.equal((second.details as { startLine: number }).startLine, 10);
    assert.ok(Buffer.byteLength(second.content[0]?.type === "text" ? second.content[0].text : "") <= 64 * 1024);

    const searchTool = createResultSearchTool({ store, currentSessionId: () => "session-a" });
    const search = await searchTool.execute("search-1", {
      resultId,
      query: "late-failure-marker",
      contextBytes: 128,
    });
    const searchDetails = search.details as { matches: Array<{ text: string }> };
    assert.equal(searchDetails.matches.length, 1);
    assert.match(searchDetails.matches[0]?.text ?? "", /late-failure-marker/);
    assert.ok(Buffer.byteLength(search.content[0]?.type === "text" ? search.content[0].text : "") <= 64 * 1024);
  });
});
