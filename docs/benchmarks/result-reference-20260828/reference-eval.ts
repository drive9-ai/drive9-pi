import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AfterToolCallContext } from "@earendil-works/pi-agent-core";
import {
  createAfterToolCallFallback,
  createResultReadTool,
  createResultSearchTool,
} from "../../../src/pi-adapters.js";
import { PersistentToolResultStore } from "../../../src/tool-result-store.js";
import {
  ResultStoreError,
  type ResultStoreBackend,
  type ResultStoreObject,
  type ToolResultIdentity,
} from "../../../src/tool-result-types.js";

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

function identity(sessionId: string, runId: string, toolCallId: string, attempt = 0): ToolResultIdentity {
  return { sessionId, runId, toolCallId, attempt };
}

function toolContext(text: string, toolCallId: string, toolName = "inventory_scan"): AfterToolCallContext {
  return {
    assistantMessage: {} as AfterToolCallContext["assistantMessage"],
    toolCall: { type: "toolCall", id: toolCallId, name: toolName, arguments: {} },
    args: {},
    result: { content: [{ type: "text", text }], details: { raw: true } },
    isError: false,
    context: { systemPrompt: "", messages: [] },
  };
}

function textFrom(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

function buildCorpus(lineCount: number): { corpus: string; markers: Record<string, { line: number; text: string }> } {
  const positions = {
    orderId: Math.max(8, Math.floor(lineCount * 0.01)),
    vectorCas: Math.max(12, Math.floor(lineCount * 0.14)),
    rollback: Math.max(16, Math.floor(lineCount * 0.38)),
    tenant: Math.max(20, Math.floor(lineCount * 0.64)),
    tail: Math.max(24, lineCount - 10),
  };
  const markers = {
    orderId: { line: positions.orderId, text: "ANSWER order_id=DR9-ORDER-739142" },
    vectorCas: { line: positions.vectorCas, text: "ANSWER vector_cas=VECTOR-CAS-7719" },
    rollback: { line: positions.rollback, text: "ANSWER rollback_scope=FUSE-ONLY-2486" },
    tenant: { line: positions.tenant, text: 'ANSWER tenant={"region":"ap-southeast-3","ttl":42}' },
    tail: { line: positions.tail, text: "ANSWER tail_sentinel=END-OF-RESULT-5901" },
  } satisfies Record<string, { line: number; text: string }>;

  const lines: string[] = [];
  for (let i = 0; i < lineCount; i += 1) {
    const marker = Object.values(markers).find((entry) => entry.line === i);
    const filler = [
      `line=${i.toString().padStart(5, "0")}`,
      "module=drive9-pi",
      "payload=abcdefghijklmnopqrstuvwxyz0123456789",
      "note=ordinary log noise that should not be model-visible unless retrieved",
    ].join(" ");
    lines.push(marker === undefined ? filler : `${filler} ${marker.text}`);
  }
  return { corpus: `${lines.join("\n")}\n`, markers };
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

async function runCase(lineCount: number): Promise<{
  lineCount: number;
  rawBytes: number;
  compactBytes: number;
  reductionRatio: number;
  searchBytes: number;
  readBytes: number;
  resultId: string;
}> {
  const sessionId = "eval-session";
  const runId = `eval-run-${lineCount}`;
  const backend = new MemoryBackend();
  const store = new PersistentToolResultStore({ backend });
  const fallback = createAfterToolCallFallback({
    store,
    thresholdBytes: 4 * 1024,
    previewBytes: 2 * 1024,
    allocateIdentity: ({ toolCallId }) => identity(sessionId, runId, toolCallId),
  });

  const { corpus, markers } = buildCorpus(lineCount);
  const rawBytes = bytes(corpus);

  const compact = await fallback(toolContext(corpus, `scan-call-${lineCount}`));
  assert.notEqual(compact, undefined);
  if (compact === undefined) throw new Error("large result was not compacted");
  const compactText = textFrom(compact);
  const compactBytes = bytes(compactText);
  const details = compact.details as { resultId: string; totalBytes: number; totalLines: number };
  assert.equal(details.totalBytes, rawBytes);
  assert.equal(details.totalLines, lineCount);
  assert.match(compactText, /Drive9 durable result/);
  assert.match(compactText, new RegExp(details.resultId));

  for (const [name, marker] of Object.entries(markers)) {
    if (marker.line > 50) {
      assert.equal(compactText.includes(marker.text), false, `${name} leaked into compact model context`);
    }
  }

  const readTool = createResultReadTool({ store, currentSessionId: () => sessionId });
  const searchTool = createResultSearchTool({ store, currentSessionId: () => sessionId });
  const searchResults: Record<string, { bytes: number; found: boolean; line?: number }> = {};
  for (const [name, marker] of Object.entries(markers)) {
    const probe = marker.text.split("=")[0] ?? marker.text;
    const search = await searchTool.execute(`search-${lineCount}-${name}`, {
      resultId: details.resultId,
      query: probe,
      contextBytes: 180,
      maxMatches: 1,
    });
    const output = textFrom(search);
    assert.match(output, new RegExp(marker.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    searchResults[name] = {
      bytes: bytes(output),
      found: true,
      line: (search.details as { matches: Array<{ line: number }> }).matches[0]?.line,
    };
  }

  const readPages: Record<string, { bytes: number; contains: boolean }> = {};
  for (const [name, marker] of Object.entries(markers)) {
    const read = await readTool.execute(`read-${lineCount}-${name}`, {
      resultId: details.resultId,
      startLine: Math.max(0, marker.line - 2),
      maxLines: 5,
      maxBytes: 4096,
    });
    const output = textFrom(read);
    assert.equal(output.includes(marker.text), true);
    readPages[name] = { bytes: bytes(output), contains: true };
  }

  const repeat = await fallback(toolContext(corpus, `scan-call-${lineCount}`));
  assert.notEqual(repeat, undefined);
  if (repeat === undefined) throw new Error("repeat compaction failed");
  assert.equal((repeat.details as { resultId: string }).resultId, details.resultId);

  const small = await fallback(toolContext("short result stays inline", "small-call"));
  assert.equal(small, undefined);

  const recursive = await fallback(toolContext(`${"search-result\n".repeat(1000)}`, "reader-call", "result_search"));
  assert.equal(recursive, undefined);

  const otherSessionRead = createResultReadTool({ store, currentSessionId: () => "other-session" });
  let crossSessionDenied = false;
  try {
    await otherSessionRead.execute("bad-read", { resultId: details.resultId, maxLines: 1 });
  } catch (error) {
    crossSessionDenied = error instanceof ResultStoreError && error.code === "permission_denied";
  }
  assert.equal(crossSessionDenied, true);

  const materializedContextBytes = compactBytes;
  const searchBytes = Object.values(searchResults).reduce((sum, entry) => sum + entry.bytes, 0);
  const readBytes = Object.values(readPages).reduce((sum, entry) => sum + entry.bytes, 0);

  return {
    lineCount,
    rawBytes,
    compactBytes,
    reductionRatio: Number((1 - compactBytes / rawBytes).toFixed(4)),
    searchBytes,
    readBytes,
    resultId: details.resultId,
  };
}

async function main(): Promise<void> {
  const primary = await runCase(10_000);
  const medium = await runCase(500);
  const large = await runCase(50_000);
  const summary = {
    timestamp: new Date().toISOString(),
    repoHead: "988b80f",
    rounds: {
      compactReference: {
        rawBytes: primary.rawBytes,
        compactBytes: primary.compactBytes,
        reductionRatio: primary.reductionRatio,
        resultId: primary.resultId,
        hiddenMarkersAbsentFromContext: true,
      },
      targetedSearch: {
        totalModelVisibleBytes: primary.searchBytes,
        hiddenMarkersFound: true,
      },
      boundedRead: {
        totalModelVisibleBytes: primary.readBytes,
        hiddenMarkersFound: true,
      },
      failureAndReplay: {
        stableResultIdOnReplay: true,
        smallResultInline: true,
        evidenceReaderResultsNotRecursivelyOffloaded: true,
        crossSessionDenied: true,
      },
      repeatedSizes: [medium, primary, large],
    },
    contextBudgetComparison: {
      oneRawToolResultBytes: primary.rawBytes,
      oneReferenceMessageBytes: primary.compactBytes,
      fiveRawToolResultsBytes: primary.rawBytes * 5,
      fiveReferenceMessagesBytes: primary.compactBytes * 5,
    },
  };

  const outDir = dirname(fileURLToPath(import.meta.url));
  await writeFile(resolve(outDir, "reference-eval-result.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
