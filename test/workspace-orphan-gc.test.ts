import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Context } from "@earendil-works/chord";
import type { EntryId } from "@earendil-works/pi-durable";
import { Drive9ProtocolError } from "../src/core/errors.js";
import type {
  Drive9LayerCheckpointRecord,
  Drive9LayerEventRecord,
  Drive9LayerRecord,
  Drive9LayerWorkspaceClient,
} from "../src/workspace/layer-backend.js";
import { reclaimOrphanLayers } from "../src/workspace/orphan-gc.js";
import type {
  WorkspaceCandidateDisposition,
  WorkspaceCandidateInventory,
  WorkspaceCandidateInventoryItem,
} from "../src/workspace/orphans.js";

const context: Context = {
  abortSignal: new AbortController().signal,
  value: () => undefined,
  toString: () => "orphan-gc-test",
};

class ConflictError extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/**
 * Minimal layer client whose only job is to serve a fixed layer list and record
 * (and optionally reject) deletes. GC never forks/checkpoints, so the other
 * verbs throw to prove they are not on the reclamation path.
 */
class GcFakeClient implements Drive9LayerWorkspaceClient {
  readonly deleted: string[] = [];
  listError: Error | undefined;
  /** layerIds whose non-cascading delete the server rejects with 409 (still_pins). */
  readonly stillPinned = new Set<string>();
  /** layerIds whose delete throws a non-conflict backend fault. */
  readonly deleteFaults = new Set<string>();

  constructor(private readonly layers: Drive9LayerRecord[]) {}

  async listFSLayers(): Promise<Drive9LayerRecord[]> {
    if (this.listError !== undefined) throw this.listError;
    return this.layers.map((layer) => ({ ...layer }));
  }

  async deleteFSLayer(layerId: string, options?: { readonly cascade?: boolean }): Promise<void> {
    assert.equal(options?.cascade, false, "orphan GC must always delete non-cascading");
    if (this.deleteFaults.has(layerId)) throw new Error(`backend fault deleting ${layerId}`);
    if (this.stillPinned.has(layerId)) throw new ConflictError(`still_pins ${layerId}`);
    this.deleted.push(layerId);
  }

  async getFSLayer(): Promise<Drive9LayerRecord> {
    throw new Error("getFSLayer must not be called by orphan GC");
  }
  async forkFSLayer(): Promise<Drive9LayerRecord> {
    throw new Error("forkFSLayer must not be called by orphan GC");
  }
  async checkpointFSLayer(): Promise<Drive9LayerCheckpointRecord> {
    throw new Error("checkpointFSLayer must not be called by orphan GC");
  }
  async getFSLayerCheckpoint(): Promise<Drive9LayerCheckpointRecord> {
    throw new Error("getFSLayerCheckpoint must not be called by orphan GC");
  }
  async listFSLayerEvents(): Promise<Drive9LayerEventRecord[]> {
    throw new Error("listFSLayerEvents must not be called by orphan GC");
  }
}

function layer(id: string, parent?: string): Drive9LayerRecord {
  return {
    layer_id: id,
    state: "committed",
    durable_seq: 1,
    ...(parent === undefined ? {} : { parent_layer_id: parent }),
    root_layer_id: parent === undefined ? id : "root",
  };
}

function item(
  layerId: string,
  disposition: WorkspaceCandidateDisposition,
  candidateKey = `cand-${layerId}`,
): WorkspaceCandidateInventoryItem {
  return {
    candidateKey,
    checkpointId: `ckpt-${layerId}`,
    durableSeq: 1,
    layerId,
    rootLayerId: "root",
    sessionId: "session-1",
    sourceConversationId: 1,
    taskId: 1,
    toolCallId: "tc-1",
    attemptId: 1,
    candidateEntryIds: [1 as unknown as EntryId],
    disposition,
  };
}

const UNPUBLISHABLE: WorkspaceCandidateDisposition = {
  kind: "permanently-unpublishable",
  reason: "tool-result-error",
};

function inventory(
  items: WorkspaceCandidateInventoryItem[],
  publishedCandidateKey: string | null = null,
): WorkspaceCandidateInventory {
  return {
    conversationId: 1 as unknown as WorkspaceCandidateInventory["conversationId"],
    publishedCandidateKey,
    candidateRecordCount: items.length,
    uniqueCandidateCount: items.length,
    publishedCount: items.filter((i) => i.disposition.kind === "published").length,
    permanentlyUnpublishableCount: items.filter((i) => i.disposition.kind === "permanently-unpublishable").length,
    unresolvedCount: items.filter((i) => i.disposition.kind === "unresolved").length,
    requiresAttention: true,
    items,
  };
}

describe("reclaimOrphanLayers", () => {
  it("reclaims a permanently-unpublishable layer that nothing references", async () => {
    const client = new GcFakeClient([layer("orphan")]);
    const report = await reclaimOrphanLayers({
      inventory: inventory([item("orphan", UNPUBLISHABLE)]),
      client,
      context,
    });

    assert.deepEqual(client.deleted, ["orphan"]);
    assert.equal(report.reclaimedCount, 1);
    assert.equal(report.skippedCount, 0);
    assert.equal(report.results[0]?.outcome.kind, "reclaimed");
  });

  it("never deletes a layer with a NON-candidate descendant in the full layer list", async () => {
    // The decisive reference-safety case: "child" forks from "orphan" but is NOT
    // in the candidate inventory (it is a checkpoint-only / non-candidate layer).
    // A GC that derived its child set from the inventory alone would miss this
    // reference and delete "orphan", corrupting "child". The reference index
    // MUST come from the full listFSLayers() result, so "orphan" is skipped.
    const client = new GcFakeClient([layer("orphan"), layer("child", "orphan")]);
    const report = await reclaimOrphanLayers({
      inventory: inventory([item("orphan", UNPUBLISHABLE)]), // note: no "child" candidate
      client,
      context,
    });

    assert.deepEqual(client.deleted, []);
    assert.equal(report.reclaimedCount, 0);
    assert.deepEqual(report.results.map((r) => r.outcome), [{ kind: "skipped", reason: "has-descendant" }]);
  });

  it("never deletes published or unresolved candidates", async () => {
    const client = new GcFakeClient([layer("pub"), layer("live"), layer("dead")]);
    const report = await reclaimOrphanLayers({
      inventory: inventory(
        [
          item("pub", { kind: "published", reason: "published-chain" }, "cand-pub"),
          item("live", { kind: "unresolved", reason: "task-active" }, "cand-live"),
          item("dead", UNPUBLISHABLE, "cand-dead"),
        ],
        "cand-pub",
      ),
      client,
      context,
    });

    // Only the permanently-unpublishable, unreferenced "dead" layer is reclaimed.
    assert.deepEqual(client.deleted, ["dead"]);
    assert.equal(report.reclaimedCount, 1);
  });

  it("skips (does not cascade) when the server still pins the layer at delete time", async () => {
    // A fork committed between enumeration and deletion: the server rejects the
    // non-cascading delete with 409. GC must treat that as still-referenced and
    // skip, NEVER retry with cascade.
    const client = new GcFakeClient([layer("racy")]);
    client.stillPinned.add("racy");
    const report = await reclaimOrphanLayers({
      inventory: inventory([item("racy", UNPUBLISHABLE)]),
      client,
      context,
    });

    assert.deepEqual(client.deleted, []);
    assert.equal(report.reclaimedCount, 0);
    assert.deepEqual(report.results.map((r) => r.outcome), [{ kind: "skipped", reason: "still-referenced" }]);
  });

  it("fails closed for the whole pass when the layer listing is unavailable", async () => {
    const client = new GcFakeClient([layer("orphan")]);
    client.listError = new Error("backend down");
    await assert.rejects(
      reclaimOrphanLayers({ inventory: inventory([item("orphan", UNPUBLISHABLE)]), client, context }),
      (error: unknown) =>
        error instanceof Drive9ProtocolError && /cannot enumerate layers/.test(error.message),
    );
    assert.deepEqual(client.deleted, [], "no layer is deleted when safety cannot be proven");
  });

  it("aborts the pass on a non-conflict delete fault without marking the layer reclaimed", async () => {
    const client = new GcFakeClient([layer("a"), layer("b")]);
    client.deleteFaults.add("a");
    await assert.rejects(
      reclaimOrphanLayers({
        inventory: inventory([item("a", UNPUBLISHABLE, "cand-a"), item("b", UNPUBLISHABLE, "cand-b")]),
        client,
        context,
      }),
      (error: unknown) => error instanceof Drive9ProtocolError && /failed to delete layer a/.test(error.message),
    );
  });

  it("does nothing when there are no permanently-unpublishable candidates", async () => {
    const client = new GcFakeClient([layer("live")]);
    const report = await reclaimOrphanLayers({
      inventory: inventory([item("live", { kind: "unresolved", reason: "task-active" }, "cand-live")]),
      client,
      context,
    });
    // listFSLayers is not even consulted when there is nothing reclaimable.
    assert.deepEqual(client.deleted, []);
    assert.equal(report.reclaimedCount, 0);
    assert.equal(report.skippedCount, 0);
  });
});
