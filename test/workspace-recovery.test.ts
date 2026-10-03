import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage, type ConversationId } from "@earendil-works/pi-durable";
import { Drive9ProtocolError } from "../src/core/errors.js";
import { markServerFencedStorage } from "../src/storage/profile.js";
import {
  recoverWorkspace,
  type WritableWorkspaceHandle,
  type WorkspaceBinding,
  type WorkspaceRecoveryBackend,
} from "../src/workspace/recovery.js";
import type { VerifiedWorkspaceCheckpoint } from "../src/workspace/types.js";

const source: VerifiedWorkspaceCheckpoint = {
  checkpointId: "checkpoint-published",
  durableSeq: 41,
  layerId: "layer-published",
  rootLayerId: "layer-root",
  parentLayerId: "layer-parent",
  parentCheckpointId: "checkpoint-parent",
  depth: 2,
};

function child(layerId: string): WritableWorkspaceHandle {
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

class FakeBackend implements WorkspaceRecoveryBackend {
  current: WorkspaceBinding | undefined;
  readonly forkInputs: Array<Parameters<WorkspaceRecoveryBackend["forkFromCheckpoint"]>[0]> = [];
  readonly switchInputs: Array<Parameters<WorkspaceRecoveryBackend["switchBinding"]>[0]> = [];
  readonly abandoned: WritableWorkspaceHandle[] = [];
  readonly forkResults: Array<{ readonly handle: WritableWorkspaceHandle; readonly hasUnpublishedWrites: boolean }> = [];
  switchError: Error | undefined;

  async currentBinding(): Promise<WorkspaceBinding | undefined> {
    return this.current;
  }

  async forkFromCheckpoint(
    input: Parameters<WorkspaceRecoveryBackend["forkFromCheckpoint"]>[0],
  ): Promise<{ readonly handle: WritableWorkspaceHandle; readonly hasUnpublishedWrites: boolean }> {
    this.forkInputs.push(input);
    const result = this.forkResults.shift();
    if (result === undefined) throw new Error("unexpected recovery fork");
    return result;
  }

  async switchBinding(input: Parameters<WorkspaceRecoveryBackend["switchBinding"]>[0]): Promise<void> {
    this.switchInputs.push(input);
    if (this.switchError !== undefined) throw this.switchError;
  }

  async abandon(handle: WritableWorkspaceHandle, _context: Context): Promise<void> {
    this.abandoned.push(handle);
  }
}

async function fixture(): Promise<{ storage: MemoryStorage; conversationId: ConversationId }> {
  const storage = new MemoryStorage();
  const conversationId = await storage.mintId<ConversationId>();
  await storage.commit(
    [{ type: "conversation", value: { id: conversationId } }],
    BACKGROUND_CONTEXT,
  );
  return { storage, conversationId };
}

function verifier() {
  return {
    verify: async () => {
      throw new Error("no candidate should be verified");
    },
  };
}

test("stable recovery rejects storage without a server-enforced writer epoch", async () => {
  const value = await fixture();
  const backend = new FakeBackend();
  await assert.rejects(
    recoverWorkspace({
      ...value,
      initialCheckpoint: source,
      maxLayerDepth: 16,
      verifier: verifier(),
      backend,
      context: BACKGROUND_CONTEXT,
      mode: { kind: "stable" },
    }),
    (error: unknown) => error instanceof Drive9ProtocolError && error.code === "stable_storage_required",
  );
  assert.equal(backend.forkInputs.length, 0);
});

test("stable recovery takes its writer epoch from the fenced storage profile", async () => {
  const value = await fixture();
  markServerFencedStorage(value.storage, "epoch-fenced");
  const backend = new FakeBackend();
  backend.forkResults.push({ handle: child("layer-recovered"), hasUnpublishedWrites: false });
  const recovered = await recoverWorkspace({
    ...value,
    initialCheckpoint: source,
    maxLayerDepth: 16,
    verifier: verifier(),
    backend,
    context: BACKGROUND_CONTEXT,
    mode: { kind: "stable" },
  });
  assert.equal(backend.forkInputs[0]?.writerEpoch, "epoch-fenced");
  assert.equal(recovered.binding.writerEpoch, "epoch-fenced");
});

test("reuses only an exact clean binding", async () => {
  const value = await fixture();
  const backend = new FakeBackend();
  const existing = child("layer-existing");
  backend.current = {
    conversationId: value.conversationId,
    writerEpoch: "epoch-preview",
    publishedCandidateKey: null,
    handle: existing,
    hasUnpublishedWrites: false,
  };
  const recovered = await recoverWorkspace({
    ...value,
    initialCheckpoint: source,
    maxLayerDepth: 16,
    verifier: verifier(),
    backend,
    context: BACKGROUND_CONTEXT,
    mode: { kind: "single-coordinator-preview", writerEpoch: "epoch-preview" },
  });
  assert.equal(recovered.binding, backend.current);
  assert.equal(backend.forkInputs.length, 0);
  assert.equal(backend.switchInputs.length, 0);
});

test("replaces a dirty binding with a child of the published checkpoint", async () => {
  const value = await fixture();
  const backend = new FakeBackend();
  const dirty = child("layer-dirty-current");
  const clean = child("layer-clean");
  backend.current = {
    conversationId: value.conversationId,
    writerEpoch: "epoch-preview",
    publishedCandidateKey: null,
    handle: dirty,
    hasUnpublishedWrites: true,
  };
  backend.forkResults.push({ handle: clean, hasUnpublishedWrites: false });
  const recovered = await recoverWorkspace({
    ...value,
    initialCheckpoint: source,
    maxLayerDepth: 16,
    verifier: verifier(),
    backend,
    context: BACKGROUND_CONTEXT,
    mode: { kind: "single-coordinator-preview", writerEpoch: "epoch-preview" },
  });
  assert.deepEqual(backend.forkInputs.map((input) => input.source), [source]);
  assert.equal(backend.switchInputs[0]?.expectedLayerId, dirty.layerId);
  assert.equal(recovered.binding.handle, clean);
  assert.deepEqual(backend.abandoned, [dirty]);
});

test("repeated recovery forks siblings from one published checkpoint", async () => {
  const value = await fixture();
  const backend = new FakeBackend();
  const dirtyChild = child("layer-dirty-child");
  const cleanSibling = child("layer-clean-sibling");
  backend.forkResults.push(
    { handle: dirtyChild, hasUnpublishedWrites: true },
    { handle: cleanSibling, hasUnpublishedWrites: false },
  );
  const recovered = await recoverWorkspace({
    ...value,
    initialCheckpoint: source,
    maxLayerDepth: 16,
    verifier: verifier(),
    backend,
    context: BACKGROUND_CONTEXT,
    mode: { kind: "single-coordinator-preview", writerEpoch: "epoch-preview" },
  });
  assert.equal(backend.forkInputs.length, 2);
  assert.deepEqual(backend.forkInputs.map((input) => input.source), [source, source]);
  assert.equal(backend.forkInputs.every((input) => input.childIdentity.length <= 50), true);
  assert.equal(backend.forkInputs.every((input) => input.childIdentity.startsWith("pir_")), true);
  assert.equal(dirtyChild.depth, cleanSibling.depth);
  assert.notEqual(backend.forkInputs[0]?.childIdentity, backend.forkInputs[1]?.childIdentity);
  assert.equal(recovered.binding.handle, cleanSibling);
  assert.deepEqual(backend.abandoned, [dirtyChild]);
});

test("rejects a recovery child whose lineage does not match the source", async () => {
  const value = await fixture();
  const backend = new FakeBackend();
  backend.forkResults.push({
    handle: { ...child("layer-wrong"), parentLayerId: "layer-dirty-child" },
    hasUnpublishedWrites: false,
  });
  await assert.rejects(
    recoverWorkspace({
      ...value,
      initialCheckpoint: source,
      maxLayerDepth: 16,
      verifier: verifier(),
      backend,
      context: BACKGROUND_CONTEXT,
      mode: { kind: "single-coordinator-preview", writerEpoch: "epoch-preview" },
    }),
    (error: unknown) => error instanceof Drive9ProtocolError && error.code === "checkpoint_mismatch",
  );
  assert.equal(backend.switchInputs.length, 0);
});

test("fails before forking at the configured and hard LayerFS depth limits", async () => {
  for (const maxLayerDepth of [8, 16]) {
    const value = await fixture();
    const backend = new FakeBackend();
    await assert.rejects(
      recoverWorkspace({
        ...value,
        initialCheckpoint: { ...source, depth: maxLayerDepth },
        maxLayerDepth,
        verifier: verifier(),
        backend,
        context: BACKGROUND_CONTEXT,
        mode: { kind: "single-coordinator-preview", writerEpoch: "epoch-preview" },
      }),
      (error: unknown) => error instanceof Drive9ProtocolError && error.code === "layer_depth_exhausted",
    );
    assert.equal(backend.forkInputs.length, 0);
  }
});

test("rejects a backend that returns the stale current generation as recovered", async () => {
  const value = await fixture();
  const backend = new FakeBackend();
  const dirty = child("layer-dirty-current");
  backend.current = {
    conversationId: value.conversationId,
    writerEpoch: "epoch-preview",
    publishedCandidateKey: null,
    handle: dirty,
    hasUnpublishedWrites: true,
  };
  backend.forkResults.push({ handle: dirty, hasUnpublishedWrites: false });
  await assert.rejects(
    recoverWorkspace({
      ...value,
      initialCheckpoint: source,
      maxLayerDepth: 16,
      verifier: verifier(),
      backend,
      context: BACKGROUND_CONTEXT,
      mode: { kind: "single-coordinator-preview", writerEpoch: "epoch-preview" },
    }),
    (error: unknown) => error instanceof Drive9ProtocolError && error.code === "recovery_failed",
  );
  assert.equal(backend.switchInputs.length, 0);
});

test("bounds dirty sibling reconciliation and abandons every unpublishable child", async () => {
  const value = await fixture();
  const backend = new FakeBackend();
  const dirtyChildren = Array.from({ length: 16 }, (_, index) => child(`layer-dirty-${index}`));
  backend.forkResults.push(
    ...dirtyChildren.map((handle) => ({ handle, hasUnpublishedWrites: true as const })),
  );
  await assert.rejects(
    recoverWorkspace({
      ...value,
      initialCheckpoint: source,
      maxLayerDepth: 16,
      verifier: verifier(),
      backend,
      context: BACKGROUND_CONTEXT,
      mode: { kind: "single-coordinator-preview", writerEpoch: "epoch-preview" },
    }),
    (error: unknown) => error instanceof Drive9ProtocolError && error.code === "recovery_failed",
  );
  assert.equal(backend.forkInputs.length, 16);
  assert.deepEqual(backend.forkInputs.map((input) => input.source), Array.from({ length: 16 }, () => source));
  assert.deepEqual(backend.abandoned, dirtyChildren);
  assert.equal(backend.switchInputs.length, 0);
});

test("abandons the new child when the fenced binding switch fails", async () => {
  const value = await fixture();
  const backend = new FakeBackend();
  const clean = child("layer-clean");
  const switchError = new Error("writer epoch lost");
  backend.forkResults.push({ handle: clean, hasUnpublishedWrites: false });
  backend.switchError = switchError;
  await assert.rejects(
    recoverWorkspace({
      ...value,
      initialCheckpoint: source,
      maxLayerDepth: 16,
      verifier: verifier(),
      backend,
      context: BACKGROUND_CONTEXT,
      mode: { kind: "single-coordinator-preview", writerEpoch: "epoch-preview" },
    }),
    switchError,
  );
  assert.deepEqual(backend.abandoned, [clean]);
});
