import assert from "node:assert/strict";
import { posix } from "node:path";
import { describe, it } from "node:test";
import type { Context } from "@earendil-works/chord";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import { Drive9ProtocolError } from "../src/core/errors.js";
import type {
  Drive9DurableFileSystemClient,
  Drive9FileEntry,
  Drive9Stat,
} from "../src/drive9-durable-file-system.js";
import { openDrive9SingleCoordinatorStorage } from "../src/storage/jsonl-preview.js";
import { requireServerFencedStorage, storageProfile } from "../src/storage/profile.js";

const context: Context = {
  abortSignal: new AbortController().signal,
  value: () => undefined,
  toString: () => "storage-test",
};

class StatusError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

interface MemoryNode {
  readonly isDir: boolean;
  readonly data: Uint8Array;
  readonly revision: number;
  readonly mode: number;
  readonly mtime: Date;
}

class MemoryDrive9Client implements Drive9DurableFileSystemClient {
  readonly nodes = new Map<string, MemoryNode>();
  private nextRevision = 1;

  constructor(readonly root: string) {
    this.nodes.set(root, this.node(new Uint8Array(), true, 0o40700));
  }

  async read(path: string): Promise<Uint8Array> {
    const node = this.required(path);
    if (node.isDir) throw new StatusError(400, `is a directory: ${path}`);
    return Uint8Array.from(node.data);
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    this.requireDirectory(posix.dirname(path));
    this.nodes.set(path, this.node(data, false, 0o100600));
  }

  async createFile(path: string): Promise<number> {
    this.requireDirectory(posix.dirname(path));
    if (this.nodes.has(path)) throw new StatusError(409, `already exists: ${path}`);
    const node = this.node(new Uint8Array(), false, 0o100600);
    this.nodes.set(path, node);
    return node.revision;
  }

  async append(path: string, data: Uint8Array): Promise<void> {
    this.requireDirectory(posix.dirname(path));
    const existing = this.nodes.get(path);
    if (existing?.isDir === true) throw new StatusError(400, `is a directory: ${path}`);
    const previous = existing?.data ?? new Uint8Array();
    const combined = new Uint8Array(previous.byteLength + data.byteLength);
    combined.set(previous);
    combined.set(data, previous.byteLength);
    this.nodes.set(path, this.node(combined, false, existing?.mode ?? 0o100600));
  }

  async list(path: string): Promise<Drive9FileEntry[]> {
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
    this.requireDirectory(posix.dirname(destinationPath));
    const replacements = [...this.nodes.entries()].filter(
      ([path]) => path === sourcePath || path.startsWith(`${sourcePath}/`),
    );
    if (replacements.length === 0) throw new StatusError(404, `not found: ${sourcePath}`);
    for (const path of [...this.nodes.keys()]) {
      if (path === destinationPath || path.startsWith(`${destinationPath}/`)) this.nodes.delete(path);
    }
    for (const [path] of replacements) this.nodes.delete(path);
    for (const [path, node] of replacements) {
      this.nodes.set(`${destinationPath}${path.slice(sourcePath.length)}`, node);
    }
  }

  async mkdir(path: string, mode = 0o700): Promise<void> {
    this.requireDirectory(posix.dirname(path));
    if (this.nodes.has(path)) throw new StatusError(409, `already exists: ${path}`);
    this.nodes.set(path, this.node(new Uint8Array(), true, 0o40000 | mode));
  }

  async deleteFile(path: string): Promise<void> {
    const node = this.required(path);
    if (node.isDir) throw new StatusError(400, `is a directory: ${path}`);
    this.nodes.delete(path);
  }

  async deleteDir(path: string): Promise<void> {
    this.requireDirectory(path);
    if ([...this.nodes.keys()].some((candidate) => candidate !== path && posix.dirname(candidate) === path)) {
      throw new StatusError(409, `directory is not empty: ${path}`);
    }
    this.nodes.delete(path);
  }

  async removeAll(path: string): Promise<void> {
    this.required(path);
    for (const candidate of [...this.nodes.keys()]) {
      if (candidate === path || candidate.startsWith(`${path}/`)) this.nodes.delete(candidate);
    }
  }

  private node(data: Uint8Array, isDir: boolean, mode: number): MemoryNode {
    return {
      data: Uint8Array.from(data),
      isDir,
      revision: this.nextRevision++,
      mode,
      mtime: new Date("2026-10-03T00:00:00Z"),
    };
  }

  private required(path: string): MemoryNode {
    const node = this.nodes.get(path);
    if (node === undefined) throw new StatusError(404, `not found: ${path}`);
    return node;
  }

  private requireDirectory(path: string): MemoryNode {
    const node = this.required(path);
    if (!node.isDir) throw new StatusError(400, `not a directory: ${path}`);
    return node;
  }
}

async function openStorage(client: MemoryDrive9Client) {
  return await openDrive9SingleCoordinatorStorage(
    {
      client,
      stateRoot: client.root,
      coordination: "externally-exclusive",
    },
    context,
  );
}

const conformance = createStorageConformance({
  assertions: {
    ok: (value, message) => assert.ok(value, message),
    strictEqual: (actual, expected) => assert.strictEqual(actual, expected),
    deepEqual: (actual, expected) => assert.deepStrictEqual(actual, expected),
    partialDeepEqual: (actual, expected) => assert.partialDeepStrictEqual(actual, expected),
    greaterThan: (actual, expected) => assert.ok(actual > expected, `${actual} is not greater than ${expected}`),
    rejects: async (operation, messageIncludes) => {
      await assert.rejects(operation, (error: unknown) => String(error).includes(messageIncludes));
    },
  },
  withStorage: async (use) => {
    const storage = await openStorage(new MemoryDrive9Client("/.drive9-pi/conformance"));
    try {
      await use(storage);
    } finally {
      await storage.close(context);
    }
  },
});

describe("Drive9 single-coordinator storage", () => {
  for (const testCase of conformance) it(`StorageConformance: ${testCase.name}`, testCase.run);

  it("opens an explicitly preview-profiled state namespace", async () => {
    const client = new MemoryDrive9Client("/.drive9-pi/sessions/session-1/state");
    const storage = await openStorage(client);
    try {
      assert.deepEqual(storageProfile(storage), { kind: "single-coordinator-preview" });
      assert.throws(
        () => requireServerFencedStorage(storage),
        (error: unknown) => error instanceof Drive9ProtocolError && error.code === "stable_storage_required",
      );
      assert.ok(client.nodes.has("/.drive9-pi/sessions/session-1/state"));
      assert.ok([...client.nodes.keys()].every((path) => path.startsWith(client.root)));
    } finally {
      await storage.close(context);
    }
  });

  it("recovers committed Pi state after reopening the same Drive9 namespace", async () => {
    const client = new MemoryDrive9Client("/.drive9-pi/sessions/session-2/state");
    const first = await openStorage(client);
    await first.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
    await first.close(context);

    const reopened = await openStorage(client);
    try {
      assert.deepEqual(await reopened.conversation(ROOT_CONVERSATION_ID, context), {
        id: ROOT_CONVERSATION_ID,
      });
      assert.deepEqual(storageProfile(reopened), { kind: "single-coordinator-preview" });
    } finally {
      await reopened.close(context);
    }
  });

  it("rejects callers that do not acknowledge external exclusivity", async () => {
    const client = new MemoryDrive9Client("/.drive9-pi/sessions/session-3/state");
    await assert.rejects(
      openDrive9SingleCoordinatorStorage(
        {
          client,
          stateRoot: client.root,
          coordination: "unfenced" as "externally-exclusive",
        },
        context,
      ),
      /coordination must be externally-exclusive/,
    );
  });

  it("fails closed when the pre-provisioned state root is missing", async () => {
    const client = new MemoryDrive9Client("/.drive9-pi/sessions/session-4/state");
    client.nodes.delete(client.root);
    await assert.rejects(openStorage(client), /not found/);
    assert.equal(client.nodes.size, 0);
  });

  it("fails closed when crash recovery requires unavailable nonzero truncate", async () => {
    const client = new MemoryDrive9Client("/.drive9-pi/sessions/session-5/state");
    const storage = await openStorage(client);
    await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
    await storage.close(context);

    await client.append(`${client.root}/main.jsonl`, Buffer.from('{"torn":', "utf8"));
    await assert.rejects(
      openStorage(client),
      /torn-line truncation of main\.jsonl failed: Drive9 SDK\/HTTP profile exposes no truncate-to-size primitive/,
    );
  });
});
