import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
  RuntimeNotEnabledError,
  type ExecOptions,
  type ExecRequest,
  type ExecResult,
} from "drive9";
import {
  Drive9SdkExecutionEnv,
  type Drive9SdkExecutionEnvClient,
} from "../src/environment/sdk-environment.js";

const context = (signal?: AbortSignal): Context => ({
  abortSignal: signal,
  value: () => undefined,
  toString: () => "test-ctx",
});

type ExecCall = { request: ExecRequest; options: ExecOptions };
type StoredNode = { data: Uint8Array; isDir: boolean; revision: number };

class StatusError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

class CompositeClient implements Drive9SdkExecutionEnvClient {
  readonly execCalls: ExecCall[] = [];
  readonly nodes = new Map<string, StoredNode>();
  execHandler: (request: ExecRequest, options: ExecOptions) => Promise<ExecResult> = async () => ({
    executionId: "execution-1",
    exitCode: 0,
    durationMs: 1,
    sandbox: "warm",
  });

  constructor(root = "/workspaces/project") {
    this.nodes.set(root, { data: new Uint8Array(), isDir: true, revision: 1 });
  }

  async exec(request: ExecRequest, options: ExecOptions = {}): Promise<ExecResult> {
    this.execCalls.push({ request, options });
    return await this.execHandler(request, options);
  }

  private required(path: string): StoredNode {
    const node = this.nodes.get(path);
    if (node === undefined) throw new StatusError(404, `not found: ${path}`);
    return node;
  }

  async read(path: string): Promise<Uint8Array> {
    return this.required(path).data.slice();
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    this.nodes.set(path, { data: data.slice(), isDir: false, revision: 1 });
  }

  async createFile(path: string): Promise<number> {
    if (this.nodes.has(path)) throw new StatusError(409, `already exists: ${path}`);
    this.nodes.set(path, { data: new Uint8Array(), isDir: false, revision: 1 });
    return 1;
  }

  async append(path: string, data: Uint8Array): Promise<void> {
    const existing = this.required(path);
    const combined = new Uint8Array(existing.data.byteLength + data.byteLength);
    combined.set(existing.data);
    combined.set(data, existing.data.byteLength);
    this.nodes.set(path, { ...existing, data: combined });
  }

  async list(path: string): Promise<Array<{ name: string; size: number; isDir: boolean }>> {
    const prefix = `${path}/`;
    return [...this.nodes.entries()]
      .filter(([candidate]) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"))
      .map(([candidate, node]) => ({
        name: candidate.slice(prefix.length),
        size: node.data.byteLength,
        isDir: node.isDir,
      }));
  }

  async stat(path: string): Promise<{ size: number; isDir: boolean; revision: number }> {
    const node = this.required(path);
    return { size: node.data.byteLength, isDir: node.isDir, revision: node.revision };
  }

  async rename(sourcePath: string, destinationPath: string): Promise<void> {
    const node = this.required(sourcePath);
    this.nodes.delete(sourcePath);
    this.nodes.set(destinationPath, node);
  }

  async mkdir(path: string): Promise<void> {
    if (this.nodes.has(path)) throw new StatusError(409, `already exists: ${path}`);
    this.nodes.set(path, { data: new Uint8Array(), isDir: true, revision: 1 });
  }

  async deleteFile(path: string): Promise<void> { this.nodes.delete(path); }
  async deleteDir(path: string): Promise<void> { this.nodes.delete(path); }
  async removeAll(path: string): Promise<void> {
    for (const candidate of this.nodes.keys()) {
      if (candidate === path || candidate.startsWith(`${path}/`)) this.nodes.delete(candidate);
    }
  }
}

describe("Drive9SdkExecutionEnv", () => {
  it("uses one client object for the filesystem identity and Runtime exec", async () => {
    const client = new CompositeClient();
    const environment: ExecutionEnv = new Drive9SdkExecutionEnv({
      client,
      root: "/workspaces/project",
      cwd: "/workspaces/project/src",
      id: "drive9:server:tenant:workspace",
    });
    let output = "";
    client.execHandler = async (_request, options) => {
      await options.onStdout?.(new TextEncoder().encode("remote-output"));
      return { executionId: "execution-1", exitCode: 7, durationMs: 1, sandbox: "warm" };
    };

    assert.equal(environment.id, "drive9:server:tenant:workspace");
    assert.deepEqual(await environment.absolutePath("index.ts", context()), {
      ok: true,
      value: "/workspaces/project/src/index.ts",
    });
    const executed = await environment.exec(
      "printf remote-output",
      { onOutput: (text) => { output += text; } },
      context(),
    );

    assert.deepEqual(executed, { ok: true, value: { exitCode: 7 } });
    assert.equal(output, "remote-output");
    assert.equal(client.execCalls.length, 1);
    assert.deepEqual(client.execCalls[0]?.request.workspace, { root: "/workspaces/project" });
    assert.equal(client.execCalls[0]?.request.cwd, "src");
  });

  it("reads the environment's current cwd on every exec call", async () => {
    const client = new CompositeClient();
    const environment = new Drive9SdkExecutionEnv({ client, root: "/workspaces/project" });

    assert.ok((await environment.exec("pwd", undefined, context())).ok);
    environment.cwd = "/workspaces/project/next";
    assert.ok((await environment.exec("pwd", undefined, context())).ok);
    assert.ok((await environment.exec("pwd", { cwd: "nested" }, context())).ok);

    assert.equal(client.execCalls[0]?.request.cwd, undefined);
    assert.equal(client.execCalls[1]?.request.cwd, "next");
    assert.equal(client.execCalls[2]?.request.cwd, "next/nested");
  });

  it("maps a server without Runtime to shell_unavailable", async () => {
    const client = new CompositeClient();
    client.execHandler = async () => { throw new RuntimeNotEnabledError(); };
    const environment = new Drive9SdkExecutionEnv({ client, root: "/workspaces/project" });

    const executed = await environment.exec("true", undefined, context());

    assert.equal(executed.ok, false);
    if (executed.ok) return;
    assert.equal(executed.error.code, "shell_unavailable");
    assert.equal(client.execCalls.length, 1);
  });

  it("spills complete output into the same Drive9 temp root and cleanup removes it", async () => {
    const client = new CompositeClient();
    client.execHandler = async (_request, options) => {
      await options.onStdout?.(new TextEncoder().encode("prefix"));
      await options.onStderr?.(new TextEncoder().encode("-suffix"));
      return { executionId: "execution-1", exitCode: 0, durationMs: 1, sandbox: "warm" };
    };
    const environment = new Drive9SdkExecutionEnv({
      client,
      root: "/workspaces/project",
      tempRoot: "/workspaces/project/.runtime-tmp",
    });

    const executed = await environment.exec(
      "big-output",
      { spill: { afterBytes: 7, afterLines: Number.MAX_SAFE_INTEGER } },
      context(),
    );

    assert.ok(executed.ok);
    const spillPath = executed.value.spillPath;
    if (spillPath === undefined) assert.fail("expected a Drive9 spill path");
    assert.ok(spillPath.startsWith("/workspaces/project/.runtime-tmp/runtime-exec-"));
    assert.equal(new TextDecoder().decode(await client.read(spillPath)), "prefix-suffix");
    assert.equal([...client.nodes.keys()].every((path) => path.startsWith("/workspaces/project")), true);

    await environment.cleanup(context());
    assert.equal(client.nodes.has(spillPath), false);
  });

  it("returns pre-aborted without invoking the shared client", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new CompositeClient();
    const environment = new Drive9SdkExecutionEnv({ client, root: "/workspaces/project" });

    const executed = await environment.exec("ignored", undefined, context(controller.signal));

    assert.equal(executed.ok, false);
    if (executed.ok) return;
    assert.equal(executed.error.code, "aborted");
    assert.equal(client.execCalls.length, 0);
  });

  it("does not expose a separate Runtime client option", () => {
    if (false) {
      const client = new CompositeClient();
      new Drive9SdkExecutionEnv({
        client,
        root: "/workspaces/project",
        // @ts-expect-error same-client construction is mandatory
        runtime: client,
      });
    }
    assert.ok(true);
  });
});
