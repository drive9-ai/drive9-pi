import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Drive9ResultStoreBackend,
  type Drive9ResultClient,
} from "../src/drive9-result-backend.js";
import { ResultStoreError } from "../src/tool-result-types.js";

class FakeStatusError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

interface FakeObject {
  data: Uint8Array;
  revision: number;
}

class FakeDrive9Client implements Drive9ResultClient {
  readonly objects = new Map<string, FakeObject>();
  readonly directories = new Set<string>();
  statHook?: (path: string, calls: number) => void;
  private statCalls = 0;

  async writeWithRevision(
    path: string,
    data: Uint8Array,
    options: { expectedRevision: number },
  ): Promise<number> {
    const current = this.objects.get(path);
    if (options.expectedRevision === 0) {
      if (current !== undefined) throw new FakeStatusError(409, "exists");
      this.objects.set(path, { data: Uint8Array.from(data), revision: 1 });
      return 1;
    }
    if (current === undefined) throw new FakeStatusError(404, "missing");
    if (current.revision !== options.expectedRevision) throw new FakeStatusError(409, "revision mismatch");
    const revision = current.revision + 1;
    this.objects.set(path, { data: Uint8Array.from(data), revision });
    return revision;
  }

  async read(path: string): Promise<Uint8Array> {
    const current = this.objects.get(path);
    if (current === undefined) throw new FakeStatusError(404, "missing");
    return Uint8Array.from(current.data);
  }

  async stat(path: string): Promise<{ size: number; isDir: boolean; revision: number }> {
    this.statCalls += 1;
    this.statHook?.(path, this.statCalls);
    const current = this.objects.get(path);
    if (current === undefined) throw new FakeStatusError(404, "missing");
    return { size: current.data.byteLength, isDir: false, revision: current.revision };
  }

  async mkdir(path: string): Promise<void> {
    if (this.directories.has(path)) throw new FakeStatusError(409, "exists");
    this.directories.add(path);
  }
}

describe("Drive9ResultStoreBackend", () => {
  it("creates parent directories and uses Drive9 revision CAS", async () => {
    const client = new FakeDrive9Client();
    const backend = new Drive9ResultStoreBackend({ client, evidenceRoot: "/evidence/results" });
    const created = await backend.create("v1/results/aa/manifest.json", Buffer.from("one"));
    assert.equal(created.revision, 1);
    assert.deepEqual([...client.directories], [
      "/evidence/results",
      "/evidence/results/v1",
      "/evidence/results/v1/results",
      "/evidence/results/v1/results/aa",
    ]);
    const replaced = await backend.replace("v1/results/aa/manifest.json", Buffer.from("two"), 1);
    assert.equal(replaced.revision, 2);
    const read = await backend.read("v1/results/aa/manifest.json");
    assert.equal(read.revision, 2);
    assert.equal(Buffer.from(read.data).toString("utf8"), "two");
  });

  it("retries a read when revision changes between stat calls", async () => {
    const client = new FakeDrive9Client();
    client.objects.set("/evidence/object", { data: Buffer.from("old"), revision: 1 });
    client.statHook = (path, calls) => {
      if (path === "/evidence/object" && calls === 2) {
        client.objects.set(path, { data: Buffer.from("new-value"), revision: 2 });
      }
    };
    const backend = new Drive9ResultStoreBackend({ client, evidenceRoot: "/evidence", stableReadAttempts: 2 });
    const read = await backend.read("object");
    assert.equal(read.revision, 2);
    assert.equal(Buffer.from(read.data).toString("utf8"), "new-value");
  });

  it("fails closed when every stable read attempt races", async () => {
    const client = new FakeDrive9Client();
    client.objects.set("/evidence/object", { data: Buffer.from("0"), revision: 1 });
    client.statHook = (path, calls) => {
      if (calls % 2 === 0) {
        const current = client.objects.get(path);
        if (current !== undefined) {
          const revision = current.revision + 1;
          client.objects.set(path, { data: Buffer.from(String(revision)), revision });
        }
      }
    };
    const backend = new Drive9ResultStoreBackend({ client, evidenceRoot: "/evidence", stableReadAttempts: 2 });
    await assert.rejects(
      async () => await backend.read("object"),
      (error: unknown) => error instanceof ResultStoreError && error.code === "unavailable",
    );
  });

  it("maps Drive9 authorization, missing, and CAS failures", async () => {
    const client = new FakeDrive9Client();
    const backend = new Drive9ResultStoreBackend({ client, evidenceRoot: "/evidence" });
    await assert.rejects(
      async () => await backend.read("missing"),
      (error: unknown) => error instanceof ResultStoreError && error.code === "not_found",
    );
    client.read = async () => {
      throw new FakeStatusError(403, "denied");
    };
    client.objects.set("/evidence/denied", { data: Buffer.from("x"), revision: 1 });
    await assert.rejects(
      async () => await backend.read("denied"),
      (error: unknown) => error instanceof ResultStoreError && error.code === "permission_denied",
    );
    const second = new FakeDrive9Client();
    second.objects.set("/evidence/object", { data: Buffer.from("x"), revision: 2 });
    const secondBackend = new Drive9ResultStoreBackend({ client: second, evidenceRoot: "/evidence" });
    await assert.rejects(
      async () => await secondBackend.replace("object", Buffer.from("y"), 1),
      (error: unknown) => error instanceof ResultStoreError && error.code === "conflict",
    );
  });

  it("rejects paths outside the evidence namespace", async () => {
    const backend = new Drive9ResultStoreBackend({ client: new FakeDrive9Client(), evidenceRoot: "/evidence" });
    for (const path of ["/absolute", "../escape", "a/../b", "a\\b", ""]) {
      await assert.rejects(
        async () => await backend.create(path, Buffer.from("x")),
        (error: unknown) => error instanceof ResultStoreError && error.code === "invalid",
      );
    }
  });
});
