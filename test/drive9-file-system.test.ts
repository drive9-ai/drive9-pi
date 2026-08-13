import assert from "node:assert/strict";
import { posix } from "node:path";
import { describe, it } from "node:test";
import { getOrThrow, type Result } from "@earendil-works/pi-agent-core";
import type { FSLayer, FSLayerEntry } from "drive9";
import {
  Drive9FileSystem,
  type Drive9BaseFileInfo,
  type Drive9BaseStat,
  type Drive9LayerFileSystemClient,
} from "../src/drive9-file-system.js";

class StatusError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message = `status ${statusCode}`) {
    super(message);
    this.statusCode = statusCode;
  }
}

interface BaseNode {
  data: Uint8Array;
  isDir: boolean;
  revision: number;
  mode: number;
  mtime: Date;
}

class FakeLayerClient implements Drive9LayerFileSystemClient {
  readonly root = "/workspace";
  readonly base = new Map<string, BaseNode>();
  readonly entries = new Map<string, FSLayerEntry>();
  readonly layerData = new Map<string, Uint8Array>();
  readonly uploadCalls: Array<{ path: string; baseRevision?: number }> = [];
  readonly entryCalls: Array<{ path: string; op: string; baseRevision?: number }> = [];
  getCalls = 0;
  diffCalls = 0;
  readCalls = 0;
  statCalls = 0;
  listCalls = 0;
  advanceAfterNextDiff = false;
  failGet: unknown;
  private sequence = 0;

  constructor() {
    this.addBaseDirectory(this.root, 1);
  }

  get mutationCount(): number {
    return this.uploadCalls.length + this.entryCalls.length;
  }

  get totalCallCount(): number {
    return this.getCalls + this.diffCalls + this.readCalls + this.statCalls + this.listCalls + this.mutationCount;
  }

  addBaseDirectory(path: string, revision = 1): void {
    this.base.set(path, {
      data: new Uint8Array(),
      isDir: true,
      revision,
      mode: 0o40755,
      mtime: new Date("2026-08-13T00:00:00Z"),
    });
  }

  addBaseFile(path: string, text: string, revision = 1): void {
    this.base.set(path, {
      data: Buffer.from(text),
      isDir: false,
      revision,
      mode: 0o100644,
      mtime: new Date("2026-08-13T00:00:00Z"),
    });
  }

  async getFSLayer(layerId: string): Promise<FSLayer> {
    this.getCalls += 1;
    if (this.failGet !== undefined) throw this.failGet;
    return {
      layer_id: layerId,
      base_root_path: this.root,
      name: "test",
      state: "active",
      durability_mode: "sync",
      actor_id: "test",
      durable_seq: this.sequence,
      created_at: "2026-08-13T00:00:00Z",
      updated_at: "2026-08-13T00:00:00Z",
    };
  }

  async diffFSLayer(_layerId: string, maxSeq?: number): Promise<FSLayerEntry[]> {
    this.diffCalls += 1;
    const entries = [...this.entries.values()].filter((entry) => maxSeq === undefined || entry.entry_seq <= maxSeq);
    if (this.advanceAfterNextDiff) {
      this.advanceAfterNextDiff = false;
      this.sequence += 1;
    }
    return entries;
  }

  async readFSLayerFile(_layerId: string, path: string): Promise<Uint8Array> {
    this.readCalls += 1;
    const data = this.layerData.get(path);
    if (data === undefined) throw new StatusError(404);
    return Uint8Array.from(data);
  }

  async uploadFSLayerFile(
    layerId: string,
    path: string,
    data: Uint8Array,
    options?: { baseRevision?: number; mode?: number },
  ): Promise<FSLayerEntry> {
    this.uploadCalls.push({ path, ...(options?.baseRevision === undefined ? {} : { baseRevision: options.baseRevision }) });
    this.layerData.set(path, Uint8Array.from(data));
    return this.putEntry(layerId, path, "upsert", "file", data.byteLength, options?.baseRevision ?? 0, options?.mode);
  }

  async upsertFSLayerEntry(
    layerId: string,
    request: {
      path: string;
      op: "mkdir" | "whiteout";
      kind: "file" | "dir" | "symlink";
      mode?: number;
      baseRevision?: number;
    },
  ): Promise<FSLayerEntry> {
    this.entryCalls.push({
      path: request.path,
      op: request.op,
      ...(request.baseRevision === undefined ? {} : { baseRevision: request.baseRevision }),
    });
    if (request.op === "whiteout") this.layerData.delete(request.path);
    return this.putEntry(
      layerId,
      request.path,
      request.op,
      request.kind,
      0,
      request.baseRevision ?? 0,
      request.mode,
    );
  }

  async read(path: string): Promise<Uint8Array> {
    this.readCalls += 1;
    const node = this.base.get(path);
    if (node === undefined) throw new StatusError(404);
    if (node.isDir) throw new StatusError(400);
    return Uint8Array.from(node.data);
  }

  async list(path: string): Promise<Drive9BaseFileInfo[]> {
    this.listCalls += 1;
    const directory = this.base.get(path);
    if (directory === undefined) throw new StatusError(404);
    if (!directory.isDir) throw new StatusError(400);
    return [...this.base.entries()]
      .filter(([candidate]) => candidate !== path && posix.dirname(candidate) === path)
      .map(([candidate, node]) => ({
        name: posix.basename(candidate),
        size: node.data.byteLength,
        isDir: node.isDir,
        mtime: node.mtime,
        mode: node.mode,
      }));
  }

  async stat(path: string): Promise<Drive9BaseStat> {
    this.statCalls += 1;
    const node = this.base.get(path);
    if (node === undefined) throw new StatusError(404);
    return {
      size: node.data.byteLength,
      isDir: node.isDir,
      revision: node.revision,
      mtime: node.mtime,
      mode: node.mode,
    };
  }

  private putEntry(
    layerId: string,
    path: string,
    op: FSLayerEntry["op"],
    kind: FSLayerEntry["kind"],
    size: number,
    baseRevision: number,
    mode = kind === "dir" ? 0o755 : 0o644,
  ): FSLayerEntry {
    this.sequence += 1;
    const entry: FSLayerEntry = {
      layer_id: layerId,
      path,
      parent_path: posix.dirname(path),
      name: posix.basename(path),
      op,
      kind,
      base_inode_id: "",
      base_revision: baseRevision,
      storage_type: op === "upsert" ? "s3" : "",
      storage_ref: op === "upsert" ? `layers/${layerId}/${this.sequence}` : "",
      storage_ref_hash: "",
      storage_encryption_mode: "none",
      storage_encryption_key_id: "",
      checksum_sha256: "",
      size_bytes: size,
      mode,
      entry_seq: this.sequence,
      created_at: "2026-08-13T00:00:00Z",
      updated_at: "2026-08-13T00:00:00Z",
    };
    this.entries.set(path, entry);
    return entry;
  }
}

function createFileSystem(
  client = new FakeLayerClient(),
  options?: { maxLayerEntries?: number; viewTimeoutMs?: number },
): Drive9FileSystem {
  return new Drive9FileSystem({
    client,
    layerId: "layer-1",
    root: client.root,
    ...(options?.maxLayerEntries === undefined ? {} : { maxLayerEntries: options.maxLayerEntries }),
    ...(options?.viewTimeoutMs === undefined ? {} : { viewTimeoutMs: options.viewTimeoutMs }),
  });
}

function assertErrorCode(result: Result<unknown, { code: string }>, code: string): void {
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, code);
}

describe("Drive9FileSystem", () => {
  it("uses only LayerFS SDK mutations and preserves base revision", async () => {
    const client = new FakeLayerClient();
    client.addBaseFile("/workspace/file.txt", "base", 9);
    const fileSystem = createFileSystem(client);

    getOrThrow(await fileSystem.writeFile("file.txt", "layer"));
    assert.deepEqual(client.uploadCalls, [{ path: "/workspace/file.txt", baseRevision: 9 }]);
    assert.equal(getOrThrow(await fileSystem.readTextFile("file.txt")), "layer");
    assert.equal(Buffer.from(getOrThrow(await fileSystem.readBinaryFile("file.txt"))).toString(), "layer");
  });

  it("merges base and layer with whiteout, shadow, recreate, and deterministic ordering", async () => {
    const client = new FakeLayerClient();
    client.addBaseFile("/workspace/base-only.txt", "base-only");
    client.addBaseFile("/workspace/hidden.txt", "hidden");
    client.addBaseFile("/workspace/shared.txt", "old");
    client.addBaseDirectory("/workspace/recreated");
    client.addBaseFile("/workspace/recreated/old-child.txt", "old-child");
    await client.uploadFSLayerFile("layer-1", "/workspace/shared.txt", Buffer.from("new"));
    await client.upsertFSLayerEntry("layer-1", { path: "/workspace/hidden.txt", op: "whiteout", kind: "file" });
    await client.upsertFSLayerEntry("layer-1", { path: "/workspace/recreated", op: "whiteout", kind: "dir" });
    await client.upsertFSLayerEntry("layer-1", { path: "/workspace/recreated", op: "mkdir", kind: "dir" });
    await client.uploadFSLayerFile("layer-1", "/workspace/recreated/new-child.txt", Buffer.from("new-child"));
    const fileSystem = createFileSystem(client);

    assert.equal(getOrThrow(await fileSystem.readTextFile("shared.txt")), "new");
    assertErrorCode(await fileSystem.fileInfo("hidden.txt"), "not_found");
    assert.deepEqual(
      getOrThrow(await fileSystem.listDir(".")).map(({ name }) => name),
      ["base-only.txt", "recreated", "shared.txt"],
    );
    assert.deepEqual(
      getOrThrow(await fileSystem.listDir("recreated")).map(({ name }) => name),
      ["new-child.txt"],
    );
    assertErrorCode(await fileSystem.fileInfo("recreated/old-child.txt"), "not_found");
  });

  it("preserves every child returned by the non-paginated base list contract", async () => {
    const client = new FakeLayerClient();
    for (let index = 0; index < 1_025; index += 1) {
      client.addBaseFile(`/workspace/file-${index.toString().padStart(4, "0")}.txt`, String(index));
    }
    const fileSystem = createFileSystem(client);

    const entries = getOrThrow(await fileSystem.listDir("."));
    assert.equal(entries.length, 1_025);
    assert.equal(entries[0]?.name, "file-0000.txt");
    assert.equal(entries.at(-1)?.name, "file-1024.txt");
    assert.equal(client.listCalls, 1);
  });

  it("whiteouts a single object without deleting base storage", async () => {
    const client = new FakeLayerClient();
    client.addBaseFile("/workspace/remove.txt", "keep-in-base", 4);
    const fileSystem = createFileSystem(client);

    getOrThrow(await fileSystem.remove("remove.txt"));
    assert.equal(client.base.has("/workspace/remove.txt"), true);
    assert.deepEqual(client.entryCalls, [{ path: "/workspace/remove.txt", op: "whiteout", baseRevision: 4 }]);
    assert.equal(getOrThrow(await fileSystem.exists("remove.txt")), false);
  });

  it("uses one stable layer view for directory emptiness and whiteout", async () => {
    const client = new FakeLayerClient();
    client.addBaseDirectory("/workspace/empty", 7);
    const fileSystem = createFileSystem(client);

    getOrThrow(await fileSystem.remove("empty"));
    assert.equal(client.diffCalls, 1);
    assert.deepEqual(client.entryCalls, [{ path: "/workspace/empty", op: "whiteout", baseRevision: 7 }]);
  });

  it("fails unsupported append, rename, and recursive remove before mutation", async () => {
    const client = new FakeLayerClient();
    const fileSystem = createFileSystem(client);

    assertErrorCode(await fileSystem.appendFile("file.txt", "x"), "not_supported");
    assertErrorCode(await fileSystem.renameFile("from.txt", "to.txt"), "not_supported");
    assertErrorCode(await fileSystem.remove("directory", { recursive: true }), "not_supported");
    assert.equal(client.mutationCount, 0);
  });

  it("rejects root escape before any backend call", async () => {
    const client = new FakeLayerClient();
    const fileSystem = createFileSystem(client);

    assertErrorCode(await fileSystem.readTextFile("../secret"), "permission_denied");
    assertErrorCode(await fileSystem.writeFile("/outside/file", "blocked"), "permission_denied");
    assertErrorCode(await fileSystem.remove("../outside", { recursive: true }), "permission_denied");
    assert.equal(client.totalCallCount, 0);
  });

  it("retries a moved layer sequence and caps whole-layer enumeration", async () => {
    const retryClient = new FakeLayerClient();
    retryClient.advanceAfterNextDiff = true;
    const retryFileSystem = createFileSystem(retryClient);
    assert.equal(getOrThrow(await retryFileSystem.fileInfo(".")).kind, "directory");
    assert.equal(retryClient.diffCalls, 2);

    const cappedClient = new FakeLayerClient();
    await cappedClient.uploadFSLayerFile("layer-1", "/workspace/one", Buffer.from("1"));
    await cappedClient.uploadFSLayerFile("layer-1", "/workspace/two", Buffer.from("2"));
    const cappedFileSystem = createFileSystem(cappedClient, { maxLayerEntries: 1 });
    assertErrorCode(await cappedFileSystem.listDir("."), "not_supported");
  });

  it("bounds LayerFS view assembly time", async () => {
    const client = new FakeLayerClient();
    client.getFSLayer = async () => await new Promise<never>(() => {});
    const fileSystem = createFileSystem(client, { viewTimeoutMs: 5 });
    assertErrorCode(await fileSystem.fileInfo("."), "unknown");
  });

  it("creates SDK-backed directories and temporary objects, then cleans owned objects", async () => {
    const client = new FakeLayerClient();
    const fileSystem = createFileSystem(client);

    getOrThrow(await fileSystem.createDir("generated/nested"));
    assert.equal(getOrThrow(await fileSystem.fileInfo("generated/nested")).kind, "directory");
    const temporaryFile = getOrThrow(await fileSystem.createTempFile({ prefix: "pi-", suffix: ".tmp" }));
    assert.equal(getOrThrow(await fileSystem.exists(temporaryFile)), true);
    await fileSystem.cleanup();
    assert.equal(getOrThrow(await fileSystem.exists(temporaryFile)), false);
    assertErrorCode(await fileSystem.createTempDir("../escape"), "invalid");
  });

  it("maps aborts and backend failures to FileError results without rejection", async () => {
    const client = new FakeLayerClient();
    const fileSystem = createFileSystem(client);
    const controller = new AbortController();
    controller.abort();
    assertErrorCode(await fileSystem.readTextFile("file.txt", controller.signal), "aborted");

    client.failGet = new StatusError(403, "denied");
    assertErrorCode(await fileSystem.fileInfo("."), "permission_denied");
  });
});
