import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AfterToolCallContext } from "@earendil-works/pi-agent-core";
import {
  createAfterToolCallFallback,
  createResultReadTool,
  createResultSearchTool,
  type ToolResultIdentityAllocator,
} from "../src/pi-adapters.js";
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

async function persistText(
  store: PersistentToolResultStore,
  resultIdentity: ToolResultIdentity,
  text: string,
  state: "completed" | "failed" = "completed",
): Promise<string> {
  const begun = await store.begin({
    identity: resultIdentity,
    toolName: "fixture",
    mediaType: "text/plain; charset=utf-8",
  });
  assert.equal(begun.kind, "writing");
  if (begun.kind !== "writing") throw new Error("unexpected terminal result");
  await begun.writer.append({ seq: 0, stream: "tool", data: Buffer.from(text) });
  return (await begun.writer.finalize({ state, chunkCount: 1 })).resultId;
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
  it("offloads only oversized all-text results and emits a compact reference", async () => {
    const store = new PersistentToolResultStore({ backend: new MemoryBackend() });
    const text = `${"x".repeat(60 * 1024)}\nknown-late-failure\n`;
    const fallback = createAfterToolCallFallback({
      store,
      allocateIdentity: allocatorFor(identity(0), identity(0)),
    });

    assert.equal(await fallback(fallbackContext("small")), undefined);
    const overridden = await fallback(fallbackContext(text));
    assert.notEqual(overridden, undefined);
    const details = overridden?.details as { resultId: string; totalBytes: number; state: string };
    assert.equal(details.totalBytes, Buffer.byteLength(text));
    assert.equal(details.state, "completed");
    const read = await store.readRange(details.resultId, { offset: 0, length: 64 * 1024 });
    assert.equal(Buffer.from(read.bytes).toString(), text);
    assert.ok(Buffer.byteLength(overridden?.content?.[0]?.type === "text" ? overridden.content[0].text : "") <= 8192);
    const repeated = await fallback(fallbackContext(text));
    assert.equal((repeated?.details as { resultId: string }).resultId, details.resultId);
  });

  it("records tool failure and an SDK checkpoint binding without launching commands", async () => {
    const store = new PersistentToolResultStore({ backend: new MemoryBackend() });
    let captures = 0;
    const fallback = createAfterToolCallFallback({
      store,
      allocateIdentity: allocatorFor(identity(0)),
      thresholdBytes: 1,
      workspaceRevisionProvider: {
        capture: async () => {
          captures += 1;
          return {
            layerId: "layer-1",
            durableSeq: 8,
            snapshotId: "checkpoint-8",
            capturedAt: "2026-08-13T00:00:00.000Z",
          };
        },
      },
    });
    const result = await fallback(fallbackContext("failed tool output", true));
    const details = result?.details as { state: string; workspaceAfter?: { durableSeq: number } };
    assert.equal(captures, 1);
    assert.equal(details.state, "failed");
    assert.equal(details.workspaceAfter?.durableSeq, 8);
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
