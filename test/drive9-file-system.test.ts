import assert from "node:assert/strict";
import { posix } from "node:path";
import { describe, it } from "node:test";
import { getOrThrow, type Result } from "@earendil-works/pi-agent-core";
import {
  Drive9FileSystem,
  type Drive9FileEntry,
  type Drive9FileSystemClient,
  type Drive9Stat,
} from "../src/drive9-file-system.js";

class StatusError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message = `status ${statusCode}`) {
    super(message);
    this.statusCode = statusCode;
  }
}

interface Node {
  data: Uint8Array;
  isDir: boolean;
  revision: number;
  mode: number;
  mtime: Date;
}

class FakeClient implements Drive9FileSystemClient {
  readonly nodes = new Map<string, Node>();
  readonly calls: Array<{ method: string; paths: string[] }> = [];
  failNext: unknown;
  private revision = 1;

  constructor(readonly root = "/workspace") {
    this.addDirectory(root);
  }

  get callCount(): number {
    return this.calls.length;
  }

  addDirectory(path: string, mode = 0o40755): void {
    this.nodes.set(path, this.node(new Uint8Array(), true, mode));
  }

  addFile(path: string, content: string, mode = 0o100644): void {
    this.nodes.set(path, this.node(Buffer.from(content), false, mode));
  }

  text(path: string): string {
    const node = this.nodes.get(path);
    if (node === undefined || node.isDir) throw new Error(`not a file: ${path}`);
    return Buffer.from(node.data).toString("utf8");
  }

  async read(path: string): Promise<Uint8Array> {
    this.record("read", path);
    const node = this.required(path);
    if (node.isDir) throw new StatusError(400, `is a directory: ${path}`);
    return Uint8Array.from(node.data);
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    this.record("write", path);
    this.requireDirectory(posix.dirname(path));
    this.nodes.set(path, this.node(data, false, 0o100644));
  }

  async append(path: string, data: Uint8Array): Promise<void> {
    this.record("append", path);
    this.requireDirectory(posix.dirname(path));
    const current = this.nodes.get(path);
    if (current?.isDir === true) throw new StatusError(400, `is a directory: ${path}`);
    const existing = current?.data ?? new Uint8Array();
    const combined = new Uint8Array(existing.byteLength + data.byteLength);
    combined.set(existing);
    combined.set(data, existing.byteLength);
    this.nodes.set(path, this.node(combined, false, current?.mode ?? 0o100644));
  }

  async list(path: string): Promise<Drive9FileEntry[]> {
    this.record("list", path);
    this.requireDirectory(path);
    return [...this.nodes.entries()]
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
    this.record("stat", path);
    const node = this.required(path);
    return {
      size: node.data.byteLength,
      isDir: node.isDir,
      revision: node.revision,
      mtime: node.mtime,
      mode: node.mode,
    };
  }

  async rename(sourcePath: string, destinationPath: string): Promise<void> {
    this.record("rename", sourcePath, destinationPath);
    this.requireDirectory(posix.dirname(destinationPath));
    const source = this.required(sourcePath);
    const replacements = [...this.nodes.entries()].filter(
      ([path]) => path === sourcePath || path.startsWith(`${sourcePath}/`),
    );
    this.nodes.delete(destinationPath);
    for (const [path] of replacements) this.nodes.delete(path);
    for (const [path, node] of replacements) {
      this.nodes.set(`${destinationPath}${path.slice(sourcePath.length)}`, node);
    }
    if (replacements.length === 0) this.nodes.set(destinationPath, source);
  }

  async mkdir(path: string, mode = 0o755): Promise<void> {
    this.record("mkdir", path);
    this.requireDirectory(posix.dirname(path));
    if (this.nodes.has(path)) throw new StatusError(409, `already exists: ${path}`);
    this.nodes.set(path, this.node(new Uint8Array(), true, 0o40000 | mode));
  }

  async deleteFile(path: string): Promise<void> {
    this.record("deleteFile", path);
    const node = this.required(path);
    if (node.isDir) throw new StatusError(400, `is a directory: ${path}`);
    this.nodes.delete(path);
  }

  async deleteDir(path: string): Promise<void> {
    this.record("deleteDir", path);
    this.requireDirectory(path);
    if ([...this.nodes.keys()].some((candidate) => candidate !== path && posix.dirname(candidate) === path)) {
      throw new StatusError(400, `directory not empty: ${path}`);
    }
    this.nodes.delete(path);
  }

  async removeAll(path: string): Promise<void> {
    this.record("removeAll", path);
    this.required(path);
    for (const candidate of [...this.nodes.keys()]) {
      if (candidate === path || candidate.startsWith(`${path}/`)) this.nodes.delete(candidate);
    }
  }

  private node(data: Uint8Array, isDir: boolean, mode: number): Node {
    return {
      data: Uint8Array.from(data),
      isDir,
      revision: this.revision++,
      mode,
      mtime: new Date("2026-08-13T00:00:00Z"),
    };
  }

  private required(path: string): Node {
    const node = this.nodes.get(path);
    if (node === undefined) throw new Error(`not found: ${path}`);
    return node;
  }

  private requireDirectory(path: string): Node {
    const node = this.required(path);
    if (!node.isDir) throw new StatusError(400, `not a directory: ${path}`);
    return node;
  }

  private record(method: string, ...paths: string[]): void {
    if (this.failNext !== undefined) {
      const failure = this.failNext;
      this.failNext = undefined;
      throw failure;
    }
    this.calls.push({ method, paths });
  }
}

function createFileSystem(client = new FakeClient()): Drive9FileSystem {
  return new Drive9FileSystem({ client, root: client.root });
}

function assertErrorCode(result: Result<unknown, { code: string }>, code: string): void {
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, code);
}

describe("Drive9FileSystem", () => {
  it("maps the Pi filesystem contract to ordinary Drive9 SDK operations", async () => {
    const client = new FakeClient();
    const fileSystem = createFileSystem(client);

    getOrThrow(await fileSystem.writeFile("src/auth.ts", "first"));
    getOrThrow(await fileSystem.appendFile("src/auth.ts", " second"));
    assert.equal(getOrThrow(await fileSystem.readTextFile("src/auth.ts")), "first second");

    getOrThrow(await fileSystem.renameFile("src/auth.ts", "src/login.ts"));
    assert.equal(getOrThrow(await fileSystem.exists("src/auth.ts")), false);
    assert.equal(getOrThrow(await fileSystem.readTextFile("src/login.ts")), "first second");
    assert.deepEqual(
      getOrThrow(await fileSystem.listDir("src")).map((entry) => entry.name),
      ["login.ts"],
    );

    getOrThrow(await fileSystem.remove("src", { recursive: true }));
    assert.equal(getOrThrow(await fileSystem.exists("src")), false);
    assert.deepEqual(
      client.calls.filter((call) => ["write", "append", "rename", "removeAll"].includes(call.method)),
      [
        { method: "write", paths: ["/workspace/src/auth.ts"] },
        { method: "append", paths: ["/workspace/src/auth.ts"] },
        { method: "rename", paths: ["/workspace/src/auth.ts", "/workspace/src/login.ts"] },
        { method: "removeAll", paths: ["/workspace/src"] },
      ],
    );
  });

  it("creates recursive parents and preserves direct non-recursive mkdir behavior", async () => {
    const client = new FakeClient();
    const fileSystem = createFileSystem(client);

    getOrThrow(await fileSystem.createDir("a/b/c"));
    assert.equal(getOrThrow(await fileSystem.fileInfo("a/b/c")).kind, "directory");
    assert.deepEqual(
      client.calls.filter((call) => call.method === "mkdir"),
      [
        { method: "mkdir", paths: ["/workspace/a"] },
        { method: "mkdir", paths: ["/workspace/a/b"] },
        { method: "mkdir", paths: ["/workspace/a/b/c"] },
      ],
    );

    assertErrorCode(await fileSystem.createDir("missing/child", { recursive: false }), "not_found");
    client.addFile("/workspace/file-parent", "not a directory");
    assertErrorCode(await fileSystem.writeFile("file-parent/child", "x"), "not_directory");
  });

  it("sorts listings and rejects malformed backend child names", async () => {
    const client = new FakeClient();
    client.addFile("/workspace/z.txt", "z");
    client.addDirectory("/workspace/a");
    const fileSystem = createFileSystem(client);

    assert.deepEqual(
      getOrThrow(await fileSystem.listDir(".")).map((entry) => [entry.name, entry.kind]),
      [
        ["a", "directory"],
        ["z.txt", "file"],
      ],
    );

    client.list = async () => [{ name: "../escape", size: 0, isDir: false }];
    assertErrorCode(await fileSystem.listDir("."), "unknown");
  });

  it("handles symlinks without silently following them", async () => {
    const client = new FakeClient();
    client.addFile("/workspace/link", "target", 0o120777);
    const fileSystem = createFileSystem(client);

    assert.equal(getOrThrow(await fileSystem.fileInfo("link")).kind, "symlink");
    assertErrorCode(await fileSystem.readBinaryFile("link"), "not_supported");
    assertErrorCode(await fileSystem.writeFile("link", "replacement"), "not_supported");
    assertErrorCode(await fileSystem.canonicalPath("link"), "not_supported");
    assert.equal(client.text("/workspace/link"), "target");
  });

  it("implements force, non-empty, recursive, and root removal semantics", async () => {
    const client = new FakeClient();
    client.addDirectory("/workspace/dir");
    client.addFile("/workspace/dir/file", "x");
    const fileSystem = createFileSystem(client);

    assertErrorCode(await fileSystem.remove("dir"), "invalid");
    assert.equal(client.nodes.has("/workspace/dir/file"), true);
    getOrThrow(await fileSystem.remove("missing", { force: true }));
    assertErrorCode(await fileSystem.remove("missing"), "not_found");
    assertErrorCode(await fileSystem.remove("."), "permission_denied");

    getOrThrow(await fileSystem.remove("dir", { recursive: true }));
    assert.equal(client.nodes.has("/workspace/dir"), false);
    assert.equal(client.nodes.has("/workspace/dir/file"), false);
  });

  it("rejects root escape before any Drive9 SDK call", async () => {
    const client = new FakeClient();
    const fileSystem = createFileSystem(client);
    const before = client.callCount;

    assertErrorCode(await fileSystem.readTextFile("../secret"), "permission_denied");
    assertErrorCode(await fileSystem.writeFile("/other/file", "x"), "permission_denied");
    assertErrorCode(await fileSystem.renameFile("../source", "target"), "permission_denied");
    assert.equal(client.callCount, before);
  });

  it("creates and cleans only adapter-owned temporary paths", async () => {
    const client = new FakeClient();
    client.addFile("/workspace/keep.txt", "keep");
    const fileSystem = createFileSystem(client);

    const temporaryDirectory = getOrThrow(await fileSystem.createTempDir("run-"));
    const temporaryFile = getOrThrow(await fileSystem.createTempFile({ prefix: "out-", suffix: ".log" }));
    getOrThrow(await fileSystem.writeFile(posix.join(temporaryDirectory, "nested.txt"), "nested"));

    await fileSystem.cleanup();
    assert.equal(client.nodes.has(temporaryDirectory), false);
    assert.equal(client.nodes.has(temporaryFile), false);
    assert.equal(client.nodes.has("/workspace/keep.txt"), true);
  });

  it("maps aborts, real SDK not-found messages, and backend failures to FileError results", async () => {
    const client = new FakeClient();
    const fileSystem = createFileSystem(client);
    const controller = new AbortController();
    controller.abort();

    const before = client.callCount;
    assertErrorCode(await fileSystem.writeFile("aborted", "x", controller.signal), "aborted");
    assert.equal(client.callCount, before);
    assert.equal(getOrThrow(await fileSystem.exists("missing")), false);

    client.failNext = new StatusError(403, "denied");
    assertErrorCode(await fileSystem.fileInfo("."), "permission_denied");
    client.failNext = new Error("network unavailable");
    assertErrorCode(await fileSystem.listDir("."), "unknown");
  });
});
