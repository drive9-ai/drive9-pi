import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Drive9ProtocolError } from "../src/core/errors.js";
import {
  Drive9LayerWorkspaceBackend,
  type Drive9LayerBindingStore,
  type Drive9LayerCheckpointRecord,
  type Drive9LayerEventRecord,
  type Drive9LayerRecord,
  type Drive9LayerWorkspaceClient,
  type StoredWorkspaceBinding,
  type WorkspaceBindingSwitch,
  type WorkspaceBindingSwitchReceipt,
} from "../src/workspace/layer-backend.js";
import type { WritableWorkspaceHandle } from "../src/workspace/recovery.js";
import type { VerifiedWorkspaceCheckpoint } from "../src/workspace/types.js";

const conversationId = 7 as ConversationId;
const source: VerifiedWorkspaceCheckpoint = {
  checkpointId: "checkpoint-published",
  durableSeq: 41,
  layerId: "layer-published",
  rootLayerId: "layer-root",
  parentLayerId: "layer-parent",
  parentCheckpointId: "checkpoint-parent",
  depth: 2,
};

function layer(input: Partial<Drive9LayerRecord> & Pick<Drive9LayerRecord, "layer_id">): Drive9LayerRecord {
  return {
    state: "active",
    durable_seq: 0,
    parent_layer_id: source.layerId,
    origin_checkpoint_id: source.checkpointId,
    root_layer_id: source.rootLayerId,
    depth: source.depth + 1,
    ...input,
  };
}

function sourceLayer(): Drive9LayerRecord {
  return layer({
    layer_id: source.layerId,
    durable_seq: source.durableSeq,
    parent_layer_id: source.parentLayerId!,
    origin_checkpoint_id: source.parentCheckpointId!,
    root_layer_id: source.rootLayerId,
    depth: source.depth,
  });
}

function checkpointRecord(input: Partial<Drive9LayerCheckpointRecord> = {}): Drive9LayerCheckpointRecord {
  return {
    checkpoint_id: source.checkpointId,
    layer_id: source.layerId,
    durable_seq: source.durableSeq,
    ...input,
  };
}

function handle(layerId = "layer-child"): WritableWorkspaceHandle {
  return {
    layerId,
    rootLayerId: source.rootLayerId,
    parentLayerId: source.layerId,
    parentCheckpointId: source.checkpointId,
    sourceCheckpointId: source.checkpointId,
    depth: source.depth + 1,
    executionEnvId: `drive9-layer:${layerId}`,
  };
}

class ConflictError extends Error {
  readonly statusCode = 409;
}

class FakeClient implements Drive9LayerWorkspaceClient {
  readonly layers = new Map<string, Drive9LayerRecord>([[source.layerId, sourceLayer()]]);
  readonly checkpoints = new Map<string, Drive9LayerCheckpointRecord>([[source.checkpointId, checkpointRecord()]]);
  readonly events = new Map<string, Drive9LayerEventRecord[]>();
  readonly calls: Array<{ readonly method: string; readonly args: readonly unknown[] }> = [];
  forkError: Error | undefined;
  checkpointError: Error | undefined;

  async getFSLayer(layerId: string): Promise<Drive9LayerRecord> {
    this.calls.push({ method: "getFSLayer", args: [layerId] });
    const value = this.layers.get(layerId);
    if (value === undefined) throw new Error(`missing layer ${layerId}`);
    return value;
  }

  async forkFSLayer(
    parentRef: string,
    request: { readonly layer_id?: string; readonly checkpoint_id?: string } = {},
  ): Promise<Drive9LayerRecord> {
    this.calls.push({ method: "forkFSLayer", args: [parentRef, request] });
    if (this.forkError !== undefined) throw this.forkError;
    const child = layer({ layer_id: request.layer_id ?? "generated-child" });
    this.layers.set(child.layer_id, child);
    return child;
  }

  async deleteFSLayer(layerId: string, options?: { readonly cascade?: boolean }): Promise<void> {
    this.calls.push({ method: "deleteFSLayer", args: [layerId, options] });
  }

  async checkpointFSLayer(
    layerId: string,
    request: { readonly checkpoint_id?: string },
  ): Promise<Drive9LayerCheckpointRecord> {
    this.calls.push({ method: "checkpointFSLayer", args: [layerId, request] });
    const record = {
      checkpoint_id: request.checkpoint_id ?? "generated-checkpoint",
      layer_id: layerId,
      durable_seq: 9,
    };
    this.checkpoints.set(record.checkpoint_id, record);
    if (this.checkpointError !== undefined) throw this.checkpointError;
    return record;
  }

  async getFSLayerCheckpoint(checkpointId: string): Promise<Drive9LayerCheckpointRecord> {
    this.calls.push({ method: "getFSLayerCheckpoint", args: [checkpointId] });
    const value = this.checkpoints.get(checkpointId);
    if (value === undefined) throw new Error(`missing checkpoint ${checkpointId}`);
    return value;
  }

  async listFSLayerEvents(layerId: string, since?: number): Promise<Drive9LayerEventRecord[]> {
    this.calls.push({ method: "listFSLayerEvents", args: [layerId, since] });
    return this.events.get(layerId) ?? [];
  }
}

class FakeBindings implements Drive9LayerBindingStore {
  current: StoredWorkspaceBinding | undefined;
  receipt: WorkspaceBindingSwitchReceipt | undefined;
  switchError: Error | undefined;
  readonly switches: WorkspaceBindingSwitch[] = [];

  async readBinding(): Promise<StoredWorkspaceBinding | undefined> {
    return this.current;
  }

  async compareAndSetBinding(input: WorkspaceBindingSwitch): Promise<WorkspaceBindingSwitchReceipt> {
    this.switches.push(input);
    if (this.switchError !== undefined) throw this.switchError;
    const receipt = this.receipt ?? {
      previousLayerId: input.expectedLayerId,
      binding: {
        conversationId: input.conversationId,
        writerEpoch: input.writerEpoch,
        publishedCandidateKey: input.publishedCandidateKey,
        handle: input.handle,
      },
    };
    this.current = receipt.binding;
    return receipt;
  }
}

function fixture(): {
  client: FakeClient;
  bindings: FakeBindings;
  backend: Drive9LayerWorkspaceBackend;
} {
  const client = new FakeClient();
  const bindings = new FakeBindings();
  return { client, bindings, backend: new Drive9LayerWorkspaceBackend({ client, bindings }) };
}

function assertCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof Drive9ProtocolError && error.code === code;
}

function abortedContext(): Context {
  const controller = new AbortController();
  controller.abort();
  return {
    abortSignal: controller.signal,
    value: () => undefined,
    toString: () => "aborted-test-context",
  };
}

describe("Drive9LayerWorkspaceBackend", () => {
  it("forks the exact published checkpoint into a clean deterministic child", async () => {
    const value = fixture();
    const result = await value.backend.forkFromCheckpoint(
      { source, childIdentity: "layer-child", writerEpoch: "epoch-1" },
      BACKGROUND_CONTEXT,
    );

    assert.deepEqual(result, { handle: handle(), hasUnpublishedWrites: false });
    assert.deepEqual(
      value.client.calls.find((call) => call.method === "forkFSLayer"),
      {
        method: "forkFSLayer",
        args: [source.layerId, { layer_id: "layer-child", checkpoint_id: source.checkpointId }],
      },
    );
    assert.deepEqual(value.client.calls.at(-1), {
      method: "listFSLayerEvents",
      args: ["layer-child", 0],
    });
  });

  it("reconciles only an exact clean deterministic child after fork conflict", async () => {
    const value = fixture();
    value.client.forkError = new ConflictError("already exists");
    value.client.layers.set("layer-child", layer({ layer_id: "layer-child" }));

    const result = await value.backend.forkFromCheckpoint(
      { source, childIdentity: "layer-child", writerEpoch: "epoch-1" },
      BACKGROUND_CONTEXT,
    );
    assert.deepEqual(result, { handle: handle(), hasUnpublishedWrites: false });
    assert.equal(value.client.calls.some((call) => call.method === "getFSLayer" && call.args[0] === "layer-child"), true);
  });

  it("marks a reconciled child dirty when it has local LayerFS events", async () => {
    const value = fixture();
    value.client.forkError = new ConflictError("already exists");
    value.client.layers.set("layer-child", layer({ layer_id: "layer-child" }));
    value.client.events.set("layer-child", [
      { layer_id: "layer-child", seq: 1 },
    ]);

    const result = await value.backend.forkFromCheckpoint(
      { source, childIdentity: "layer-child", writerEpoch: "epoch-1" },
      BACKGROUND_CONTEXT,
    );
    assert.equal(result.hasUnpublishedWrites, true);
  });

  it("rejects a conflicting child with different checkpoint lineage", async () => {
    const value = fixture();
    value.client.forkError = new ConflictError("already exists");
    value.client.layers.set("layer-child", layer({
      layer_id: "layer-child",
      origin_checkpoint_id: "checkpoint-other",
    }));

    await assert.rejects(
      value.backend.forkFromCheckpoint(
        { source, childIdentity: "layer-child", writerEpoch: "epoch-1" },
        BACKGROUND_CONTEXT,
      ),
      assertCode("checkpoint_mismatch"),
    );
  });

  it("reconciles an ambiguous checkpoint create by deterministic identity", async () => {
    const value = fixture();
    const child = layer({ layer_id: "layer-child" });
    value.client.layers.set(child.layer_id, child);
    value.client.checkpointError = new Error("connection reset after commit");

    const verified = await value.backend.checkpoint(
      {
        handle: handle(),
        checkpointId: "checkpoint-candidate",
        writerEpoch: "epoch-1",
        previous: null,
      },
      BACKGROUND_CONTEXT,
    );
    assert.deepEqual(verified, {
      checkpointId: "checkpoint-candidate",
      durableSeq: 9,
      layerId: "layer-child",
      rootLayerId: source.rootLayerId,
      parentLayerId: source.layerId,
      parentCheckpointId: source.checkpointId,
      depth: source.depth + 1,
    });
    assert.equal(
      value.client.calls.some(
        (call) => call.method === "getFSLayerCheckpoint" && call.args[0] === "checkpoint-candidate",
      ),
      true,
    );
  });

  it("fails closed when an ambiguous checkpoint cannot be reconciled", async () => {
    const value = fixture();
    value.client.layers.set("layer-child", layer({ layer_id: "layer-child" }));
    value.client.checkpointFSLayer = async () => {
      throw new Error("timeout");
    };
    await assert.rejects(
      value.backend.checkpoint(
        {
          handle: handle(),
          checkpointId: "checkpoint-missing",
          writerEpoch: "epoch-1",
          previous: null,
        },
        BACKGROUND_CONTEXT,
      ),
      assertCode("candidate_commit_unknown"),
    );
  });

  it("independently reads checkpoint identity and exact layer lineage", async () => {
    const value = fixture();
    assert.deepEqual(
      await value.backend.readCheckpoint(
        { checkpointId: source.checkpointId, layerId: source.layerId },
        BACKGROUND_CONTEXT,
      ),
      source,
    );

    value.client.checkpoints.set(source.checkpointId, checkpointRecord({ layer_id: "layer-other" }));
    await assert.rejects(
      value.backend.readCheckpoint(
        { checkpointId: source.checkpointId, layerId: source.layerId },
        BACKGROUND_CONTEXT,
      ),
      assertCode("checkpoint_mismatch"),
    );
  });

  it("accepts the server's omitted optional lineage fields for a root layer", async () => {
    const value = fixture();
    value.client.layers.set("layer-root-only", {
      layer_id: "layer-root-only",
      state: "active",
      durable_seq: 0,
    });
    value.client.checkpoints.set("checkpoint-root", {
      checkpoint_id: "checkpoint-root",
      layer_id: "layer-root-only",
      durable_seq: 0,
    });

    assert.deepEqual(
      await value.backend.readCheckpoint(
        { checkpointId: "checkpoint-root", layerId: "layer-root-only" },
        BACKGROUND_CONTEXT,
      ),
      {
        checkpointId: "checkpoint-root",
        durableSeq: 0,
        layerId: "layer-root-only",
        rootLayerId: "layer-root-only",
        parentLayerId: null,
        parentCheckpointId: null,
        depth: 0,
      },
    );
  });

  it("recomputes unpublished state from physical LayerFS events", async () => {
    const value = fixture();
    const currentHandle = handle();
    value.client.layers.set(currentHandle.layerId, layer({ layer_id: currentHandle.layerId }));
    value.client.events.set(currentHandle.layerId, [
      { layer_id: currentHandle.layerId, seq: 4 },
    ]);
    value.bindings.current = {
      conversationId,
      writerEpoch: "epoch-1",
      publishedCandidateKey: "candidate-1",
      handle: currentHandle,
    };

    assert.deepEqual(await value.backend.currentBinding(conversationId, BACKGROUND_CONTEXT), {
      ...value.bindings.current,
      hasUnpublishedWrites: true,
    });
  });

  it("rejects stored binding lineage that disagrees with the physical layer", async () => {
    const value = fixture();
    value.client.layers.set("layer-child", layer({ layer_id: "layer-child" }));
    value.bindings.current = {
      conversationId,
      writerEpoch: "epoch-1",
      publishedCandidateKey: null,
      handle: { ...handle(), rootLayerId: "layer-wrong-root" },
    };

    await assert.rejects(
      value.backend.currentBinding(conversationId, BACKGROUND_CONTEXT),
      assertCode("recovery_failed"),
    );
  });

  it("accepts only an exact fenced compare-and-set receipt", async () => {
    const value = fixture();
    const input: WorkspaceBindingSwitch = {
      conversationId,
      writerEpoch: "epoch-1",
      expectedLayerId: "layer-old",
      publishedCandidateKey: "candidate-1",
      handle: handle(),
    };
    await value.backend.switchBinding(input, BACKGROUND_CONTEXT);
    assert.deepEqual(value.bindings.switches, [input]);

    const mismatch = fixture();
    mismatch.bindings.receipt = {
      previousLayerId: "layer-other",
      binding: {
        conversationId,
        writerEpoch: input.writerEpoch,
        publishedCandidateKey: input.publishedCandidateKey,
        handle: input.handle,
      },
    };
    await assert.rejects(
      mismatch.backend.switchBinding(input, BACKGROUND_CONTEXT),
      assertCode("recovery_failed"),
    );
  });

  it("fails closed when the binding store rejects a stale writer", async () => {
    const value = fixture();
    value.bindings.switchError = new ConflictError("writer epoch lost");
    await assert.rejects(
      value.backend.switchBinding(
        {
          conversationId,
          writerEpoch: "epoch-stale",
          expectedLayerId: "layer-old",
          publishedCandidateKey: null,
          handle: handle(),
        },
        BACKGROUND_CONTEXT,
      ),
      assertCode("recovery_failed"),
    );
  });

  it("abandons a generation without cascading into descendants", async () => {
    const value = fixture();
    await value.backend.abandon(handle(), BACKGROUND_CONTEXT);
    assert.deepEqual(value.client.calls, [
      { method: "deleteFSLayer", args: ["layer-child", { cascade: false }] },
    ]);
  });

  it("does not call Drive9 when the context is already aborted", async () => {
    const value = fixture();
    await assert.rejects(
      value.backend.forkFromCheckpoint(
        { source, childIdentity: "layer-child", writerEpoch: "epoch-1" },
        abortedContext(),
      ),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    assert.deepEqual(value.client.calls, []);
  });
});
