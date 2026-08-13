import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  deriveResultId,
  PersistentToolResultStore,
  ResultStoreError,
  type BeginResultInput,
  type ResultStoreBackend,
  type ResultStoreObject,
  type ResultWriter,
  type ToolResultIdentity,
} from "../src/index.js";

interface MemoryEntry {
  data: Uint8Array;
  revision: number;
}

class MemoryResultStoreBackend implements ResultStoreBackend {
  readonly entries = new Map<string, MemoryEntry>();
  loseCreateResponses = 0;
  loseReplaceResponses = 0;
  beforeChunkCreate?: () => Promise<void>;
  nextReadError?: unknown;

  async create(path: string, data: Uint8Array): Promise<{ revision: number }> {
    if (path.includes("/chunks/") && this.beforeChunkCreate !== undefined) await this.beforeChunkCreate();
    if (this.entries.has(path)) throw new ResultStoreError("conflict", `object exists: ${path}`);
    this.entries.set(path, { data: new Uint8Array(data), revision: 1 });
    if (this.loseCreateResponses > 0) {
      this.loseCreateResponses -= 1;
      throw new ResultStoreError("unavailable", "create response lost");
    }
    return { revision: 1 };
  }

  async read(path: string): Promise<ResultStoreObject> {
    if (this.nextReadError !== undefined) {
      const error = this.nextReadError;
      this.nextReadError = undefined;
      throw error;
    }
    const entry = this.entries.get(path);
    if (!entry) throw new ResultStoreError("not_found", `object not found: ${path}`);
    return { data: new Uint8Array(entry.data), revision: entry.revision };
  }

  async replace(path: string, data: Uint8Array, expectedRevision: number): Promise<{ revision: number }> {
    const entry = this.entries.get(path);
    if (!entry) throw new ResultStoreError("not_found", `object not found: ${path}`);
    if (entry.revision !== expectedRevision) throw new ResultStoreError("conflict", `revision conflict: ${path}`);
    const revision = entry.revision + 1;
    this.entries.set(path, { data: new Uint8Array(data), revision });
    if (this.loseReplaceResponses > 0) {
      this.loseReplaceResponses -= 1;
      throw new ResultStoreError("unavailable", "replace response lost");
    }
    return { revision };
  }

  pathEndingWith(suffix: string): string {
    const matches = [...this.entries.keys()].filter((path) => path.endsWith(suffix));
    assert.equal(matches.length, 1, `expected one path ending with ${suffix}`);
    return matches[0]!;
  }

  overwrite(path: string, data: Uint8Array): void {
    const entry = this.entries.get(path);
    assert.ok(entry, `missing ${path}`);
    this.entries.set(path, { data: new Uint8Array(data), revision: entry.revision + 1 });
  }
}

const identity: ToolResultIdentity = {
  sessionId: "session-α",
  runId: "run-1",
  toolCallId: "tool-call-1",
  attempt: 0,
};

const workspaceBefore = {
  layerId: "layer-1",
  durableSeq: 41,
  snapshotId: "checkpoint-before",
  capturedAt: "2026-08-11T10:00:00.000Z",
};

const workspaceAfter = {
  layerId: "layer-1",
  durableSeq: 42,
  snapshotId: "checkpoint-after",
  capturedAt: "2026-08-11T10:01:00.000Z",
};

function beginInput(overrides?: Partial<BeginResultInput>): BeginResultInput {
  return {
    identity,
    toolName: "fixture_tool",
    mediaType: "text/plain; charset=utf-8",
    workspaceBefore,
    ...overrides,
  };
}

function createStore(backend = new MemoryResultStoreBackend(), limits?: Record<string, number>) {
  return {
    backend,
    store: new PersistentToolResultStore({ backend, ...limits }),
  };
}

async function createdWriter(store: PersistentToolResultStore): Promise<ResultWriter> {
  const begun = await store.begin(beginInput());
  assert.equal(begun.kind, "writing");
  if (begun.kind !== "writing") throw new Error("expected writer");
  assert.equal(begun.disposition, "created");
  return begun.writer;
}

async function rejectCode(promise: Promise<unknown>, code: ResultStoreError["code"]): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof ResultStoreError && error.code === code);
}

describe("result identity", () => {
  it("uses a stable versioned canonical encoding without identity aliasing", () => {
    assert.equal(deriveResultId(identity), "r1_90da9279d0ac2192343a196e0a5fac41cdffb2835bedee8c7f7c3f2219eccf7b");
    assert.equal(deriveResultId({ ...identity }), deriveResultId(identity));
    assert.notEqual(deriveResultId({ ...identity, attempt: 1 }), deriveResultId(identity));
    assert.notEqual(deriveResultId({ ...identity, toolCallId: "tool-call-2" }), deriveResultId(identity));
    assert.notEqual(
      deriveResultId({ sessionId: "a", runId: "bc", toolCallId: "x", attempt: 0 }),
      deriveResultId({ sessionId: "ab", runId: "c", toolCallId: "x", attempt: 0 }),
    );
    assert.notEqual(
      deriveResultId({ sessionId: "a", runId: "b", toolCallId: "cx", attempt: 0 }),
      deriveResultId({ sessionId: "a", runId: "bc", toolCallId: "x", attempt: 0 }),
    );
    assert.throws(() => deriveResultId({ ...identity, sessionId: "" }), /non-empty UTF-8/);
    assert.throws(() => deriveResultId({ ...identity, sessionId: "\ud800" }), /non-empty UTF-8/);
    assert.throws(() => deriveResultId({ ...identity, attempt: Number.MAX_SAFE_INTEGER + 1 }), /safe integer/);
    assert.throws(
      () => deriveResultId(null as unknown as ToolResultIdentity),
      (error: unknown) => error instanceof ResultStoreError && error.code === "invalid",
    );
  });
});

describe("PersistentToolResultStore write protocol", () => {
  it("distinguishes created, existing, conflicting, and terminal begin outcomes", async () => {
    const { store } = createStore();
    const [first, second] = await Promise.all([store.begin(beginInput()), store.begin(beginInput())]);
    assert.deepEqual(
      [first, second].map((result) => (result.kind === "writing" ? result.disposition : result.kind)).sort(),
      ["created", "existing"],
    );
    for (const result of [first, second]) {
      assert.equal(result.kind, "writing");
      if (result.kind === "writing") assert.equal(result.writer.nextSeq, 0);
    }

    await rejectCode(store.begin(beginInput({ toolName: "different-tool" })), "conflict");
    const writer = first.kind === "writing" ? first.writer : undefined;
    assert.ok(writer);
    await writer.finalize({ state: "completed", chunkCount: 0 });
    const terminal = await store.begin(beginInput());
    assert.equal(terminal.kind, "terminal");
    if (terminal.kind === "terminal") assert.equal(terminal.stat.complete, true);
  });

  it("supports immutable idempotent chunks and exact idempotent finalization", async () => {
    const { store } = createStore();
    const writer = await createdWriter(store);
    const chunks = [Buffer.from("alpha\n"), Buffer.from("βeta\n"), Buffer.from("omega")];
    await writer.append({ seq: 0, stream: "stdout", data: chunks[0]! });
    await writer.append({ seq: 0, stream: "stdout", data: chunks[0]! });
    assert.equal(writer.nextSeq, 1);
    await rejectCode(writer.append({ seq: 0, stream: "stderr", data: chunks[0]! }), "conflict");
    await rejectCode(writer.append({ seq: 0, stream: "stdout", data: Buffer.from("different") }), "conflict");
    await writer.append({ seq: 1, stream: "stderr", data: chunks[1]! });
    await writer.append({ seq: 2, stream: "tool", data: chunks[2]! });
    assert.equal(writer.nextSeq, 3);

    const finalize = { state: "failed" as const, chunkCount: 3, exitCode: 2, workspaceAfter };
    const stat = await writer.finalize(finalize);
    const body = Buffer.concat(chunks);
    assert.equal(stat.state, "failed");
    assert.equal(stat.complete, true);
    assert.equal(stat.chunkCount, 3);
    assert.equal(stat.totalBytes, body.length);
    assert.equal(stat.totalLines, 3);
    assert.equal(stat.sha256, createHash("sha256").update(body).digest("hex"));
    assert.deepEqual(stat.workspaceBefore, workspaceBefore);
    assert.deepEqual(stat.workspaceAfter, workspaceAfter);
    assert.equal(stat.manifestRevision, 5);
    assert.deepEqual(await writer.finalize(finalize), stat);
    await rejectCode(writer.finalize({ ...finalize, exitCode: 3 }), "conflict");
    await rejectCode(writer.append({ seq: 3, stream: "stdout", data: Buffer.from("late") }), "conflict");
  });

  it("rejects gaps, count mismatches, invalid UTF-8, and configured limits", async () => {
    const { store } = createStore(new MemoryResultStoreBackend(), {
      maxChunkBytes: 4,
      maxChunks: 3,
      maxResultBytes: 5,
    });
    const writer = await createdWriter(store);
    await rejectCode(writer.append({ seq: 0, stream: "stdout", data: Buffer.from("12345") }), "limit_exceeded");
    await rejectCode(writer.append({ seq: 3, stream: "stdout", data: Buffer.from("x") }), "limit_exceeded");
    await rejectCode(writer.append({ seq: 0, stream: "stdout", data: Uint8Array.from([0xe2, 0x82]) }), "invalid");
    await rejectCode(writer.append({ seq: 1, stream: "stdout", data: Buffer.from("b") }), "conflict");
    await rejectCode(writer.finalize({ state: "completed", chunkCount: 2 }), "conflict");

    const secondIdentity = { ...identity, attempt: 1 };
    const second = await store.begin(beginInput({ identity: secondIdentity }));
    assert.equal(second.kind, "writing");
    if (second.kind !== "writing") return;
    await second.writer.append({ seq: 0, stream: "stdout", data: Buffer.from("abc") });
    await rejectCode(second.writer.append({ seq: 1, stream: "stdout", data: Buffer.from("def") }), "limit_exceeded");

    const thirdIdentity = { ...identity, attempt: 2 };
    const third = await store.begin(beginInput({ identity: thirdIdentity }));
    assert.equal(third.kind, "writing");
    if (third.kind !== "writing") return;
    await third.writer.append({ seq: 0, stream: "stdout", data: Buffer.from("a") });
    await third.writer.append({ seq: 1, stream: "stdout", data: Buffer.from("b") });
    await rejectCode(third.writer.finalize({ state: "completed", chunkCount: 1 }), "conflict");
  });

  it("recovers safely from lost create, append, and finalize responses", async () => {
    const backend = new MemoryResultStoreBackend();
    const { store } = createStore(backend);
    backend.loseCreateResponses = 1;
    await rejectCode(store.begin(beginInput()), "unavailable");
    const resumed = await store.begin(beginInput());
    assert.equal(resumed.kind, "writing");
    if (resumed.kind !== "writing") return;
    assert.equal(resumed.disposition, "existing");
    assert.equal(resumed.writer.nextSeq, 0);

    backend.loseCreateResponses = 1;
    await rejectCode(resumed.writer.append({ seq: 0, stream: "stdout", data: Buffer.from("saved") }), "unavailable");
    const candidateOnly = await store.stat(resumed.writer.resultId);
    assert.equal(candidateOnly.state, "writing");
    assert.equal(candidateOnly.chunkCount, 0);
    assert.equal(candidateOnly.totalBytes, 0);
    assert.equal(resumed.writer.nextSeq, 0);
    await resumed.writer.append({ seq: 0, stream: "stdout", data: Buffer.from("saved") });
    assert.equal(resumed.writer.nextSeq, 1);

    backend.loseReplaceResponses = 1;
    await resumed.writer.append({ seq: 1, stream: "stdout", data: Buffer.from("!") });
    assert.equal(resumed.writer.nextSeq, 2);

    backend.loseReplaceResponses = 1;
    const finalize = { state: "completed" as const, chunkCount: 2 };
    const stat = await resumed.writer.finalize(finalize);
    assert.equal(stat.state, "completed");
    assert.equal(stat.sha256, createHash("sha256").update("saved!").digest("hex"));
    assert.deepEqual(await resumed.writer.finalize(finalize), stat);
  });

  it("terminalizes a writing prefix as explicit unknown without inventing completion", async () => {
    const { store } = createStore();
    const writer = await createdWriter(store);
    await writer.append({ seq: 0, stream: "stdout", data: Buffer.from("partial\n") });
    const resultId = writer.resultId;
    const stat = await store.recover(resultId, { identity, action: "mark_unknown", reason: "process state lost" });
    assert.equal(stat.state, "unknown");
    assert.equal(stat.complete, false);
    assert.equal(stat.chunkCount, 1);
    await rejectCode(store.readRange(resultId, { offset: 0, length: 8 }), "incomplete");
    const readable = await store.readRange(resultId, { offset: 0, length: 8, allowIncomplete: true });
    assert.equal(Buffer.from(readable.bytes).toString("utf8"), "partial\n");
    assert.equal(readable.complete, false);
    assert.deepEqual(
      await store.recover(resultId, { identity, action: "mark_unknown", reason: "process state lost" }),
      stat,
    );
    await rejectCode(
      store.recover(resultId, { identity, action: "mark_unknown", reason: "different reason" }),
      "conflict",
    );
    await rejectCode(
      store.recover(resultId, { identity: { ...identity, sessionId: "other" }, action: "mark_unknown", reason: "x" }),
      "permission_denied",
    );
  });

  it("keeps a late cross-store append candidate outside the terminal committed prefix", async () => {
    const backend = new MemoryResultStoreBackend();
    const firstStore = new PersistentToolResultStore({ backend });
    const secondStore = new PersistentToolResultStore({ backend });
    const first = await firstStore.begin(beginInput());
    assert.equal(first.kind, "writing");
    if (first.kind !== "writing") return;
    await first.writer.append({ seq: 0, stream: "stdout", data: Buffer.from("kept") });
    const second = await secondStore.begin(beginInput());
    assert.equal(second.kind, "writing");
    if (second.kind !== "writing") return;
    assert.equal(second.writer.nextSeq, 1);

    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let chunkCreateStarted!: () => void;
    const chunkCreateStart = new Promise<void>((resolve) => {
      chunkCreateStarted = resolve;
    });
    backend.beforeChunkCreate = async () => {
      chunkCreateStarted();
      await createGate;
    };
    const append = first.writer.append({ seq: 1, stream: "stdout", data: Buffer.from("late") });
    await chunkCreateStart;
    const finalizeInput = { state: "completed" as const, chunkCount: 1 };
    const terminal = await second.writer.finalize(finalizeInput);
    const manifestPath = backend.pathEndingWith("/manifest.json");
    const committedChunkPath = backend.pathEndingWith("/chunks/000000000000.json");
    const terminalManifest = backend.entries.get(manifestPath);
    const committedChunk = backend.entries.get(committedChunkPath);
    assert.ok(terminalManifest);
    assert.ok(committedChunk);
    releaseCreate();
    await rejectCode(append, "conflict");

    const stat = await firstStore.stat(first.writer.resultId);
    assert.deepEqual(stat, terminal);
    assert.equal(stat.state, "completed");
    assert.equal(stat.chunkCount, 1);
    assert.equal(stat.totalBytes, 4);
    assert.equal(stat.sha256, createHash("sha256").update("kept").digest("hex"));
    assert.deepEqual(await second.writer.finalize(finalizeInput), terminal);
    assert.deepEqual(backend.entries.get(manifestPath), terminalManifest);
    assert.deepEqual(backend.entries.get(committedChunkPath), committedChunk);
    assert.ok(backend.entries.has(backend.pathEndingWith("/chunks/000000000001.json")));
    assert.equal(
      Buffer.from((await firstStore.readRange(first.writer.resultId, { offset: 0, length: 8 })).bytes).toString(),
      "kept",
    );
  });

  it("fails closed when a writing manifest references an unavailable committed chunk", async () => {
    const backend = new MemoryResultStoreBackend();
    const { store } = createStore(backend);
    const writer = await createdWriter(store);
    await writer.append({ seq: 0, stream: "stdout", data: Buffer.from("committed") });

    backend.entries.delete(backend.pathEndingWith("/chunks/000000000000.json"));
    await rejectCode(store.stat(writer.resultId), "incomplete");
    await rejectCode(writer.finalize({ state: "completed", chunkCount: 1 }), "incomplete");
  });

  it("maps malformed public inputs and backend failures to stable errors", async () => {
    const backend = new MemoryResultStoreBackend();
    const { store } = createStore(backend);
    await rejectCode(store.begin(null as unknown as BeginResultInput), "invalid");
    await rejectCode(store.begin(beginInput({ workspaceBefore: null as unknown as typeof workspaceBefore })), "invalid");
    const writer = await createdWriter(store);
    await rejectCode(writer.append(null as unknown as Parameters<ResultWriter["append"]>[0]), "invalid");
    await rejectCode(writer.finalize(null as unknown as Parameters<ResultWriter["finalize"]>[0]), "invalid");
    backend.nextReadError = new Error("backend offline");
    await rejectCode(store.stat(writer.resultId), "unavailable");
  });
});

describe("PersistentToolResultStore bounded readers", () => {
  it("reads raw byte ranges and UTF-8 line pages across chunk boundaries", async () => {
    const { store } = createStore();
    const writer = await createdWriter(store);
    const body = "零行\n一行\n二行\n";
    await writer.append({ seq: 0, stream: "stdout", data: Buffer.from("零行\n一") });
    await writer.append({ seq: 1, stream: "stdout", data: Buffer.from("行\n二行\n") });
    await writer.finalize({ state: "completed", chunkCount: 2 });

    const page = await store.readLines(writer.resultId, { startLine: 1, maxLines: 2 });
    assert.equal(page.text, "一行\n二行\n");
    assert.equal(page.startLine, 1);
    assert.equal(page.endLine, 3);
    assert.equal(page.nextCursor, undefined);
    const firstPage = await store.readLines(writer.resultId, { startLine: 0, maxLines: 1 });
    assert.equal(firstPage.text, "零行\n");
    assert.ok(firstPage.nextCursor);

    const raw = await store.readRange(writer.resultId, { offset: 1, length: 7 });
    assert.deepEqual(Buffer.from(raw.bytes), Buffer.from(body).subarray(1, 8));
    assert.equal(raw.startByte, 1);
    assert.equal(raw.endByte, 8);
    assert.equal(raw.nextOffset, 8);
  });

  it("never returns a partial line when the byte page limit is reached", async () => {
    const { store } = createStore();
    const writer = await createdWriter(store);
    await writer.append({ seq: 0, stream: "stdout", data: Buffer.from("one\nvery") });
    await writer.append({ seq: 1, stream: "stdout", data: Buffer.from("longline\nend\n") });
    await writer.finalize({ state: "completed", chunkCount: 2 });

    const page = await store.readLines(writer.resultId, { startLine: 0, maxLines: 3, maxBytes: 5 });
    assert.equal(page.text, "one\n");
    assert.equal(page.endLine, 1);
    assert.ok(page.nextCursor);
    await rejectCode(store.readLines(writer.resultId, { startLine: 1, maxLines: 1, maxBytes: 5 }), "limit_exceeded");
    const last = await store.readLines(writer.resultId, { startLine: 2, maxLines: 1, maxBytes: 5 });
    assert.equal(last.text, "end\n");
  });

  it("enforces read ceilings and rejects writing, missing, and corrupt chunks", async () => {
    const backend = new MemoryResultStoreBackend();
    const { store } = createStore(backend, { maxReadBytes: 8, maxReadLines: 2 });
    const writer = await createdWriter(store);
    await writer.append({ seq: 0, stream: "stdout", data: Buffer.from("one\ntwo\n") });
    await rejectCode(store.readRange(writer.resultId, { offset: 0, length: 1 }), "incomplete");
    await writer.finalize({ state: "completed", chunkCount: 1 });
    await rejectCode(store.readRange(writer.resultId, { offset: 0, length: 9 }), "limit_exceeded");
    await rejectCode(store.readLines(writer.resultId, { startLine: 0, maxLines: 3 }), "limit_exceeded");

    const chunkPath = backend.pathEndingWith("000000000000.json");
    backend.overwrite(chunkPath, Buffer.from("not-json"));
    await rejectCode(store.readRange(writer.resultId, { offset: 0, length: 4 }), "corrupt");
    backend.entries.delete(chunkPath);
    await rejectCode(store.readRange(writer.resultId, { offset: 0, length: 4 }), "incomplete");
  });

  it("performs literal bounded search with case folding, cross-chunk matches, and cursors", async () => {
    const { store } = createStore(new MemoryResultStoreBackend(), {
      maxSearchScanBytes: 12,
      maxSearchMatches: 2,
      maxModelResponseBytes: 32,
    });
    const writer = await createdWriter(store);
    await writer.append({ seq: 0, stream: "stdout", data: Buffer.from("Alpha cross") });
    await writer.append({ seq: 1, stream: "stdout", data: Buffer.from("Boundary\nlate FAILURE here\na a a") });
    await writer.finalize({ state: "failed", chunkCount: 2, exitCode: 1 });

    const crossChunk = await store.search(writer.resultId, {
      query: "ssboundary",
      caseSensitive: false,
      contextBytes: 16,
    });
    assert.equal(crossChunk.matches.length, 1);
    assert.match(crossChunk.matches[0]!.text.toLowerCase(), /crossboundary/);

    const firstScan = await store.search(writer.resultId, { query: "failure", caseSensitive: false });
    assert.equal(firstScan.matches.length, 0);
    assert.ok(firstScan.nextCursor);
    await rejectCode(
      store.search(writer.resultId, { query: "different", cursor: firstScan.nextCursor }),
      "invalid",
    );
    let scan = firstScan;
    for (let page = 0; page < 10 && scan.matches.length === 0 && scan.nextCursor !== undefined; page += 1) {
      scan = await store.search(writer.resultId, {
        query: "failure",
        caseSensitive: false,
        cursor: scan.nextCursor,
      });
    }
    assert.equal(scan.matches.length, 1);
    assert.equal(scan.matches[0]!.line, 1);

    const firstMatch = await store.search(writer.resultId, { query: "a", maxMatches: 1, contextBytes: 4 });
    assert.equal(firstMatch.matches.length, 1);
    assert.ok(firstMatch.nextCursor);
    const nextMatch = await store.search(writer.resultId, {
      query: "a",
      maxMatches: 1,
      contextBytes: 4,
      cursor: firstMatch.nextCursor,
    });
    assert.equal(nextMatch.matches.length, 1);
    assert.ok(nextMatch.matches[0]!.byteOffset > firstMatch.matches[0]!.byteOffset);
    assert.ok(Buffer.byteLength(firstMatch.matches[0]!.text) <= 4);

    const literal = await store.search(writer.resultId, { query: "[a-z]+" });
    assert.equal(literal.matches.length, 0);
    await rejectCode(store.search(writer.resultId, { query: "\ud800" }), "invalid");
    await rejectCode(store.search(writer.resultId, { query: "a", cursor: "invalid" }), "invalid");
  });

  it("returns every overlapping literal match exactly once across scan pages", async () => {
    const { store } = createStore(new MemoryResultStoreBackend(), {
      maxSearchScanBytes: 2,
      maxSearchMatches: 1,
    });
    const writer = await createdWriter(store);
    await writer.append({ seq: 0, stream: "stdout", data: Buffer.from("aa") });
    await writer.append({ seq: 1, stream: "stdout", data: Buffer.from("aa") });
    await writer.finalize({ state: "completed", chunkCount: 2 });

    const offsets: number[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await store.search(writer.resultId, {
        query: "aa",
        maxMatches: 1,
        contextBytes: 0,
        ...(cursor === undefined ? {} : { cursor }),
      });
      offsets.push(...result.matches.map((match) => match.byteOffset));
      cursor = result.nextCursor;
      if (cursor === undefined) break;
    }
    assert.deepEqual(offsets, [0, 1, 2]);
  });
});
