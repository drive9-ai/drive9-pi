import assert from "node:assert/strict";
import { createServer } from "node:http";
import { posix } from "node:path";
import { describe, it } from "node:test";
import type { Context } from "@earendil-works/chord";
import { getOrThrow, type Result } from "@earendil-works/pi-durable/env";
import { Client } from "drive9";
import {
  Drive9DurableFileSystem,
  type Drive9FileEntry,
  type Drive9DurableFileSystemClient,
  type Drive9Stat,
} from "../src/drive9-durable-file-system.js";

/**
 * Pi 1.0 threads a Chord {@link Context} as the LAST argument of every
 * FileSystem call (replacing the old optional `AbortSignal`). This helper
 * builds a minimal test context; pass a signal to exercise cancellation.
 */
const ctx = (signal?: AbortSignal): Context => ({
  abortSignal: signal,
  value: () => undefined,
  toString: () => "test-ctx",
});

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

class FakeClient implements Drive9DurableFileSystemClient {
  readonly nodes = new Map<string, Node>();
  readonly calls: Array<{ method: string; paths: string[] }> = [];
  failNext: unknown;
  createFileConflicts = 0;
  /**
   * Durable-ack model switch. When `"pre-commit"`, a `write` records bytes into
   * an uncommitted staging store (NOT visible to read/stat) and resolves BEFORE
   * committing — modeling a broken client that acks at "accepted". When
   * `"post-commit"` (the correct Drive9 contract), `write` makes the bytes
   * readable BEFORE it resolves, so the ack IS the durability barrier.
   */
  durableAckMode: "post-commit" | "pre-commit" = "post-commit";
  readonly pending = new Map<string, Node>();
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
    const committed = this.node(data, false, 0o100644);
    if (this.durableAckMode === "pre-commit") {
      // BROKEN model: stash into uncommitted staging and resolve immediately.
      // The bytes are NOT yet visible to read/stat, so another reader observing
      // right after the ack sees stale/absent data. A commit would have to run
      // later (it never does here), which is exactly the durability violation.
      this.pending.set(path, committed);
      return;
    }
    // CORRECT model: make the bytes readable BEFORE resolving. The resolved
    // promise (the ack) therefore guarantees the committed revision is already
    // retrievable by any other reader.
    this.nodes.set(path, committed);
  }

  async createFile(path: string): Promise<number> {
    this.record("createFile", path);
    this.requireDirectory(posix.dirname(path));
    if (this.createFileConflicts > 0) {
      this.createFileConflicts -= 1;
      throw new StatusError(409, `already exists: ${path}`);
    }
    if (this.nodes.has(path)) throw new StatusError(409, `already exists: ${path}`);
    const node = this.node(new Uint8Array(), false, 0o100600);
    this.nodes.set(path, node);
    return node.revision;
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

class StreamingClient extends FakeClient {
  chunks: Uint8Array[] = [];
  holdOpen = false;
  cancelled = false;
  readonly streamPaths: string[] = [];
  /** When set, readStream chunks the node's own committed bytes. */
  streamNodeBytes = false;

  async readStream(path: string): Promise<ReadableStream<Uint8Array>> {
    this.streamPaths.push(path);
    if (this.streamNodeBytes) {
      const node = this.nodes.get(path);
      if (node === undefined || node.isDir) throw new StatusError(404, `not found: ${path}`);
      // Chunk the committed bytes into a couple of pieces to exercise the
      // reader's incremental UTF-8 decode and newline-splitting across chunks.
      const bytes = Uint8Array.from(node.data);
      const half = Math.ceil(bytes.byteLength / 2);
      this.chunks = [bytes.subarray(0, half), bytes.subarray(half)];
    }
    let index = 0;
    return new ReadableStream<Uint8Array>({
      pull: (controller) => {
        const chunk = this.chunks[index];
        if (chunk !== undefined) {
          index += 1;
          controller.enqueue(Uint8Array.from(chunk));
        } else if (!this.holdOpen) {
          controller.close();
        }
      },
      cancel: () => {
        this.cancelled = true;
      },
    });
  }
}

function createFileSystem(client = new FakeClient()): Drive9DurableFileSystem {
  return new Drive9DurableFileSystem({ client, root: client.root });
}

function assertErrorCode(result: Result<unknown, { code: string }>, code: string): void {
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, code);
}

describe("Drive9DurableFileSystem", () => {
  it("maps the Pi filesystem contract to ordinary Drive9 SDK operations", async () => {
    const client = new FakeClient();
    const fileSystem = createFileSystem(client);

    getOrThrow(await fileSystem.writeFile("src/auth.ts", "first", ctx()));
    getOrThrow(await fileSystem.appendFile("src/auth.ts", " second", ctx()));
    assert.equal(getOrThrow(await fileSystem.readTextFile("src/auth.ts", ctx())), "first second");

    getOrThrow(await fileSystem.renameFile("src/auth.ts", "src/login.ts", ctx()));
    assert.equal(getOrThrow(await fileSystem.exists("src/auth.ts", ctx())), false);
    assert.equal(getOrThrow(await fileSystem.readTextFile("src/login.ts", ctx())), "first second");
    assert.deepEqual(
      getOrThrow(await fileSystem.listDir("src", ctx())).map((entry) => entry.name),
      ["login.ts"],
    );

    getOrThrow(await fileSystem.remove("src", { recursive: true }, ctx()));
    assert.equal(getOrThrow(await fileSystem.exists("src", ctx())), false);
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

    getOrThrow(await fileSystem.createDir("a/b/c", undefined, ctx()));
    assert.equal(getOrThrow(await fileSystem.fileInfo("a/b/c", ctx())).kind, "directory");
    assert.deepEqual(
      client.calls.filter((call) => call.method === "mkdir"),
      [
        { method: "mkdir", paths: ["/workspace/a"] },
        { method: "mkdir", paths: ["/workspace/a/b"] },
        { method: "mkdir", paths: ["/workspace/a/b/c"] },
      ],
    );

    assertErrorCode(await fileSystem.createDir("missing/child", { recursive: false }, ctx()), "not_found");
    client.addFile("/workspace/file-parent", "not a directory");
    assertErrorCode(await fileSystem.writeFile("file-parent/child", "x", ctx()), "not_directory");
  });

  it("sorts listings and rejects malformed backend child names", async () => {
    const client = new FakeClient();
    client.addFile("/workspace/z.txt", "z");
    client.addDirectory("/workspace/a");
    const fileSystem = createFileSystem(client);

    assert.deepEqual(
      getOrThrow(await fileSystem.listDir(".", ctx())).map((entry) => [entry.name, entry.kind]),
      [
        ["a", "directory"],
        ["z.txt", "file"],
      ],
    );

    client.list = async () => [{ name: "../escape", size: 0, isDir: false }];
    assertErrorCode(await fileSystem.listDir(".", ctx()), "unknown");
  });

  it("handles symlinks without silently following them", async () => {
    const client = new FakeClient();
    client.addFile("/workspace/link", "target", 0o120777);
    const fileSystem = createFileSystem(client);

    assert.equal(getOrThrow(await fileSystem.fileInfo("link", ctx())).kind, "symlink");
    assertErrorCode(await fileSystem.readBinaryFile("link", ctx()), "not_supported");
    assertErrorCode(await fileSystem.writeFile("link", "replacement", ctx()), "not_supported");
    assertErrorCode(await fileSystem.canonicalPath("link", ctx()), "not_supported");
    assert.equal(client.text("/workspace/link"), "target");
  });

  it("implements force, non-empty, recursive, and root removal semantics", async () => {
    const client = new FakeClient();
    client.addDirectory("/workspace/dir");
    client.addFile("/workspace/dir/file", "x");
    const fileSystem = createFileSystem(client);

    assertErrorCode(await fileSystem.remove("dir", undefined, ctx()), "invalid");
    assert.equal(client.nodes.has("/workspace/dir/file"), true);
    getOrThrow(await fileSystem.remove("missing", { force: true }, ctx()));
    assertErrorCode(await fileSystem.remove("missing", undefined, ctx()), "not_found");
    assertErrorCode(await fileSystem.remove(".", undefined, ctx()), "permission_denied");

    getOrThrow(await fileSystem.remove("dir", { recursive: true }, ctx()));
    assert.equal(client.nodes.has("/workspace/dir"), false);
    assert.equal(client.nodes.has("/workspace/dir/file"), false);
  });

  it("rejects root escape before any Drive9 SDK call", async () => {
    const client = new FakeClient();
    const fileSystem = createFileSystem(client);
    const before = client.callCount;

    assertErrorCode(await fileSystem.readTextFile("../secret", ctx()), "permission_denied");
    assertErrorCode(await fileSystem.writeFile("/other/file", "x", ctx()), "permission_denied");
    assertErrorCode(await fileSystem.renameFile("../source", "target", ctx()), "permission_denied");
    assert.equal(client.callCount, before);
  });

  it("rejects URL-ambiguous paths before a real Drive9 Client sends a request", async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert.ok(address !== null && typeof address === "object");
      const fileSystem = new Drive9DurableFileSystem({
        client: new Client(`http://127.0.0.1:${address.port}`, "test-key"),
        root: "/workspace",
      });
      for (const path of [
        "%2e%2e/secret",
        "encoded%2fslash",
        "query?version=1",
        "fragment#part",
        "back\\slash",
        "line\nbreak",
        "tab\tname",
        "deletekey",
        "unpaired\ud800surrogate",
      ]) {
        assertErrorCode(await fileSystem.readTextFile(path, ctx()), "invalid");
      }
      assertErrorCode(await fileSystem.createTempDir("query?prefix", ctx()), "invalid");
      assertErrorCode(await fileSystem.createTempFile({ suffix: "#fragment" }, ctx()), "invalid");
      assert.throws(
        () =>
          new Drive9DurableFileSystem({
            client: new Client(`http://127.0.0.1:${address.port}`, "test-key"),
            root: "/workspace/%2e%2e/private",
          }),
        /cannot be safely addressed/,
      );
      assert.throws(
        () =>
          new Drive9DurableFileSystem({
            client: new Client(`http://127.0.0.1:${address.port}`, "test-key"),
            root: "/workspace",
            tempRoot: "/workspace/temp#fragment",
          }),
        /cannot be safely addressed/,
      );
      assert.deepEqual(requests, []);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  it("normalizes Drive9 paths to NFC and validates cwd reassignment", async () => {
    const root = "/worksp\u00e1ce";
    const client = new FakeClient(root);
    client.addFile(`${root}/caf\u00e9.txt`, "normalized");
    const fileSystem = new Drive9DurableFileSystem({ client, root: "/workspa\u0301ce" });

    assert.equal(fileSystem.root, root);
    assert.equal(getOrThrow(await fileSystem.readTextFile("cafe\u0301.txt", ctx())), "normalized");
    assert.deepEqual(client.calls.at(-1), { method: "read", paths: [`${root}/caf\u00e9.txt`] });

    fileSystem.cwd = `${root}/re\u0301po`;
    assert.equal(fileSystem.cwd, `${root}/r\u00e9po`);
    assert.throws(() => {
      fileSystem.cwd = "/outside";
    }, /inside root/);
    assert.throws(() => {
      fileSystem.cwd = `${root}/query?value`;
    }, /cannot be safely addressed/);
  });

  it("streams bounded UTF-8 lines and cancels once maxLines is reached", async () => {
    const client = new StreamingClient();
    const emoji = Buffer.from("😀", "utf8");
    client.addFile("/workspace/log.txt", "first\r\nsec😀ond\nthird\n");
    client.chunks = [
      Buffer.from("first\r", "utf8"),
      Buffer.concat([Buffer.from("\nsec", "utf8"), emoji.subarray(0, 2)]),
      Buffer.concat([emoji.subarray(2), Buffer.from("ond\n", "utf8")]),
      Buffer.from("third\n", "utf8"),
    ];
    const fileSystem = createFileSystem(client);

    assert.deepEqual(
      getOrThrow(await fileSystem.readTextLines("log.txt", { maxLines: 2 }, ctx())),
      ["first", "sec😀ond"],
    );
    assert.deepEqual(client.streamPaths, ["/workspace/log.txt"]);
    assert.equal(client.calls.some((call) => call.method === "read"), false);
    assert.equal(client.cancelled, true);
  });

  it("cancels an in-flight line stream on abort and rejects invalid streamed UTF-8", async () => {
    const client = new StreamingClient();
    client.addFile("/workspace/log.txt", "partial");
    client.chunks = [Buffer.from("partial", "utf8")];
    client.holdOpen = true;
    const fileSystem = createFileSystem(client);
    const controller = new AbortController();
    const reading = fileSystem.readTextLines("log.txt", undefined, ctx(controller.signal));
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    assertErrorCode(await reading, "aborted");
    assert.equal(client.cancelled, true);

    const invalid = new StreamingClient();
    invalid.addFile("/workspace/invalid.txt", "placeholder");
    invalid.chunks = [Uint8Array.of(0xc3), Uint8Array.of(0x28)];
    invalid.holdOpen = true;
    assertErrorCode(await createFileSystem(invalid).readTextLines("invalid.txt", undefined, ctx()), "invalid");
    assert.equal(invalid.cancelled, true);
  });

  it("opens a streaming text line reader that yields terminated flags and EOF", async () => {
    const client = new StreamingClient();
    client.streamNodeBytes = true;
    const fileSystem = createFileSystem(client);
    // Terminated first two lines; final line has no trailing newline.
    getOrThrow(await fileSystem.writeFile("notes.txt", "a\nb\nno-newline", ctx()));

    const reader = getOrThrow(await fileSystem.openTextLineReader("notes.txt", ctx()));
    assert.deepEqual(getOrThrow(await reader.readLine(ctx())), { text: "a", terminated: true });
    assert.deepEqual(getOrThrow(await reader.readLine(ctx())), { text: "b", terminated: true });
    assert.deepEqual(getOrThrow(await reader.readLine(ctx())), { text: "no-newline", terminated: false });
    assert.equal(getOrThrow(await reader.readLine(ctx())), undefined);
    await reader.close(ctx());

    // The reader never falls back to the whole-file read() primitive.
    assert.equal(client.calls.some((call) => call.method === "read"), false);
    assert.deepEqual(client.streamPaths, ["/workspace/notes.txt"]);
  });

  it("truncates to zero bytes and refuses non-zero truncation", async () => {
    const client = new FakeClient();
    client.addFile("/workspace/data.txt", "lots of bytes");
    const fileSystem = createFileSystem(client);

    getOrThrow(await fileSystem.truncateFile("data.txt", 0, ctx()));
    assert.equal(getOrThrow(await fileSystem.readTextFile("data.txt", ctx())), "");

    // Drive9 has no native truncate-to-size primitive.
    assertErrorCode(await fileSystem.truncateFile("data.txt", 5, ctx()), "not_supported");
  });

  it("flushFile is a confirmation no-op for a normal path", async () => {
    const client = new FakeClient();
    client.addFile("/workspace/data.txt", "x");
    const fileSystem = createFileSystem(client);

    getOrThrow(await fileSystem.flushFile("data.txt", ctx()));
  });

  it("treats a resolved write as a durability barrier: committed bytes are immediately readable", async () => {
    // DISCRIMINATING durable-ack test. Drive9's contract is that `write`
    // resolves ONLY after the server commits the revision, so the ack IS the
    // durability barrier: once `writeFile` resolves, the exact bytes are
    // already retrievable by any OTHER reader (no commit step pending). We
    // simulate a second reader by issuing a plain `readTextFile` immediately
    // after the write resolves and asserting it sees the committed bytes.
    const client = new FakeClient();
    assert.equal(client.durableAckMode, "post-commit");
    const fileSystem = createFileSystem(client);

    getOrThrow(await fileSystem.writeFile("committed.txt", "committed-bytes", ctx()));
    // If the client acked at "accepted" (bytes still in the uncommitted pending
    // store, not yet in `nodes`), this read would miss them and fail. Because
    // the correct model makes bytes readable BEFORE resolving the ack, it passes.
    assert.equal(getOrThrow(await fileSystem.readTextFile("committed.txt", ctx())), "committed-bytes");
    assert.equal(client.nodes.has("/workspace/committed.txt"), true);
    assert.equal(client.pending.has("/workspace/committed.txt"), false);

    // Prove the assertion is discriminating: a BROKEN pre-commit client that
    // resolves the ack before making bytes readable leaves nothing in `nodes`,
    // so the same read sequence surfaces not_found — i.e. the test above would
    // FAIL against that model.
    const broken = new FakeClient();
    broken.durableAckMode = "pre-commit";
    const brokenFs = createFileSystem(broken);
    getOrThrow(await brokenFs.writeFile("committed.txt", "committed-bytes", ctx()));
    assertErrorCode(await brokenFs.readTextFile("committed.txt", ctx()), "not_found");
    assert.equal(broken.nodes.has("/workspace/committed.txt"), false);
    assert.equal(broken.pending.has("/workspace/committed.txt"), true);
  });

  it("creates and cleans only adapter-owned temporary paths", async () => {
    const client = new FakeClient();
    client.addFile("/workspace/keep.txt", "keep");
    const fileSystem = createFileSystem(client);

    const temporaryDirectory = getOrThrow(await fileSystem.createTempDir("run-", ctx()));
    const temporaryFile = getOrThrow(await fileSystem.createTempFile({ prefix: "out-", suffix: ".log" }, ctx()));
    getOrThrow(await fileSystem.writeFile(posix.join(temporaryDirectory, "nested.txt"), "nested", ctx()));

    await fileSystem.cleanup(ctx());
    assert.equal(client.nodes.has(temporaryDirectory), false);
    assert.equal(client.nodes.has(temporaryFile), false);
    assert.equal(client.nodes.has("/workspace/keep.txt"), true);
  });

  it("allocates temporary files atomically and retries failed cleanup", async () => {
    const client = new FakeClient();
    client.createFileConflicts = 1;
    const fileSystem = createFileSystem(client);
    const temporaryFile = getOrThrow(await fileSystem.createTempFile({ prefix: "result-", suffix: ".txt" }, ctx()));
    const createCalls = client.calls.filter((call) => call.method === "createFile");

    assert.equal(createCalls.length, 2);
    assert.notEqual(createCalls[0]?.paths[0], createCalls[1]?.paths[0]);
    assert.equal(client.calls.some((call) => call.method === "write" && call.paths[0] === temporaryFile), false);

    client.failNext = new Error("temporary network failure");
    await fileSystem.cleanup(ctx());
    assert.equal(client.nodes.has(temporaryFile), true);
    await fileSystem.cleanup(ctx());
    assert.equal(client.nodes.has(temporaryFile), false);

    const legacyClient = new FakeClient();
    Object.defineProperty(legacyClient, "createFile", { value: undefined });
    assertErrorCode(await createFileSystem(legacyClient).createTempFile(undefined, ctx()), "not_supported");
  });

  it("maps aborts, real SDK not-found messages, and backend failures to FileError results", async () => {
    const client = new FakeClient();
    const fileSystem = createFileSystem(client);
    const controller = new AbortController();
    controller.abort();

    const before = client.callCount;
    assertErrorCode(await fileSystem.writeFile("aborted", "x", ctx(controller.signal)), "aborted");
    assert.equal(client.callCount, before);
    assert.equal(getOrThrow(await fileSystem.exists("missing", ctx())), false);

    client.failNext = new StatusError(403, "denied");
    assertErrorCode(await fileSystem.fileInfo(".", ctx()), "permission_denied");
    client.failNext = new Error("network unavailable");
    assertErrorCode(await fileSystem.listDir(".", ctx()), "unknown");
  });
});
