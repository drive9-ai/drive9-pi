import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  MemoryStorage,
  type ConversationId,
  type EntryId,
  type TaskId,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Drive9ProtocolError } from "../src/core/errors.js";
import { markServerFencedStorage } from "../src/storage/profile.js";
import { buildWorkspaceAttemptData, deriveWorkspaceCandidateKey } from "../src/workspace/entries.js";
import {
  Drive9WorkspaceCoordinator,
  type WorkspaceCoordinatorBackend,
} from "../src/workspace/coordinator.js";
import type {
  WorkspaceBinding,
  WritableWorkspaceHandle,
} from "../src/workspace/recovery.js";
import type {
  VerifiedWorkspaceCheckpoint,
  WorkspaceCandidateData,
  WorkspaceCheckpointRequest,
  WorkspaceMutationPlan,
} from "../src/workspace/types.js";

const initialCheckpoint: VerifiedWorkspaceCheckpoint = {
  checkpointId: "checkpoint-initial",
  durableSeq: 3,
  layerId: "layer-root",
  rootLayerId: "layer-root",
  parentLayerId: null,
  parentCheckpointId: null,
  depth: 0,
};

function handle(layerId: string): WritableWorkspaceHandle {
  return {
    layerId,
    rootLayerId: initialCheckpoint.rootLayerId,
    parentLayerId: initialCheckpoint.layerId,
    parentCheckpointId: initialCheckpoint.checkpointId,
    sourceCheckpointId: initialCheckpoint.checkpointId,
    depth: 1,
    executionEnvId: `drive9-layer:${layerId}`,
  };
}

class FakeBackend implements WorkspaceCoordinatorBackend {
  current: WorkspaceBinding | undefined;
  readonly checkpoints = new Map<string, VerifiedWorkspaceCheckpoint>([
    [initialCheckpoint.checkpointId, initialCheckpoint],
  ]);
  readonly checkpointInputs: Array<Parameters<WorkspaceCoordinatorBackend["checkpoint"]>[0]> = [];
  readonly forkInputs: Array<Parameters<WorkspaceCoordinatorBackend["forkFromCheckpoint"]>[0]> = [];
  readonly switchInputs: Array<Parameters<WorkspaceCoordinatorBackend["switchBinding"]>[0]> = [];
  readonly abandoned: WritableWorkspaceHandle[] = [];
  readonly forkResults: Array<{ readonly handle: WritableWorkspaceHandle; readonly hasUnpublishedWrites: boolean }> = [];
  readTransform: ((checkpoint: VerifiedWorkspaceCheckpoint) => VerifiedWorkspaceCheckpoint) | undefined;

  async currentBinding(): Promise<WorkspaceBinding | undefined> {
    return this.current;
  }

  async forkFromCheckpoint(
    input: Parameters<WorkspaceCoordinatorBackend["forkFromCheckpoint"]>[0],
  ): Promise<{ readonly handle: WritableWorkspaceHandle; readonly hasUnpublishedWrites: boolean }> {
    this.forkInputs.push(input);
    const result = this.forkResults.shift();
    if (result === undefined) throw new Error("unexpected workspace fork");
    return result;
  }

  async switchBinding(input: Parameters<WorkspaceCoordinatorBackend["switchBinding"]>[0]): Promise<void> {
    this.switchInputs.push(input);
    this.current = {
      conversationId: input.conversationId,
      writerEpoch: input.writerEpoch,
      publishedCandidateKey: input.publishedCandidateKey,
      handle: input.handle,
      hasUnpublishedWrites: false,
    };
  }

  async abandon(workspace: WritableWorkspaceHandle): Promise<void> {
    this.abandoned.push(workspace);
  }

  async checkpoint(
    input: Parameters<WorkspaceCoordinatorBackend["checkpoint"]>[0],
  ): Promise<VerifiedWorkspaceCheckpoint> {
    this.checkpointInputs.push(input);
    const checkpoint = {
      checkpointId: input.checkpointId,
      durableSeq: 11,
      layerId: input.handle.layerId,
      rootLayerId: input.handle.rootLayerId,
      parentLayerId: input.handle.parentLayerId,
      parentCheckpointId: input.handle.parentCheckpointId,
      depth: input.handle.depth,
    } satisfies VerifiedWorkspaceCheckpoint;
    this.checkpoints.set(checkpoint.checkpointId, checkpoint);
    return checkpoint;
  }

  async readCheckpoint(
    input: Parameters<WorkspaceCoordinatorBackend["readCheckpoint"]>[0],
    _context: Context,
  ): Promise<VerifiedWorkspaceCheckpoint> {
    const checkpoint = this.checkpoints.get(input.checkpointId);
    if (checkpoint === undefined || checkpoint.layerId !== input.layerId) throw new Error("checkpoint not found");
    return this.readTransform?.(checkpoint) ?? checkpoint;
  }

  async verify(candidate: WorkspaceCandidateData): Promise<VerifiedWorkspaceCheckpoint> {
    return this.readCheckpoint(
      { checkpointId: candidate.checkpoint.checkpointId, layerId: candidate.checkpoint.layerId },
      BACKGROUND_CONTEXT,
    );
  }
}

async function fixture(options?: { onPoison?: (error: Drive9ProtocolError) => void }) {
  const storage = new MemoryStorage();
  const conversationId = await storage.mintId<ConversationId>();
  await storage.commit([{ type: "conversation", value: { id: conversationId } }], BACKGROUND_CONTEXT);
  markServerFencedStorage(storage, "epoch-1");
  const backend = new FakeBackend();
  const currentHandle = handle("layer-current");
  backend.current = {
    conversationId,
    writerEpoch: "epoch-1",
    publishedCandidateKey: null,
    handle: currentHandle,
    hasUnpublishedWrites: false,
  };
  const coordinator = new Drive9WorkspaceCoordinator({
    sessionId: "session-1",
    storage,
    backend,
    initialCheckpoint: async () => initialCheckpoint,
    maxLayerDepth: 16,
    mode: { kind: "stable" },
    ...(options?.onPoison === undefined ? {} : { onPoison: options.onPoison }),
  });
  return { storage, conversationId, backend, coordinator, currentHandle };
}

function environment(id: string): ExecutionEnv {
  return { id } as ExecutionEnv;
}

async function prepare(value: Awaited<ReturnType<typeof fixture>>, envId = value.currentHandle.executionEnvId) {
  return value.coordinator.prepare(
    {
      conversationId: value.conversationId,
      taskId: 2 as TaskId,
      toolCallId: "call-1",
      effect: "workspace",
      env: environment(envId),
    },
    BACKGROUND_CONTEXT,
  );
}

function checkpointRequest(
  value: Awaited<ReturnType<typeof fixture>>,
  plan: WorkspaceMutationPlan,
): WorkspaceCheckpointRequest {
  const attemptId = 5 as EntryId;
  const attempt = buildWorkspaceAttemptData({
    conversationId: Number(value.conversationId),
    taskId: 2,
    toolCallId: "call-1",
    effect: "workspace",
    plan,
  });
  return {
    checkpointId: deriveWorkspaceCandidateKey(attempt, attemptId),
    attemptId,
    conversationId: value.conversationId,
    taskId: 2 as TaskId,
    toolCallId: "call-1",
    effect: "workspace",
    plan,
  };
}

test("prepares only the exact recovered Drive9 execution namespace", async () => {
  const value = await fixture();
  const plan = await prepare(value);
  assert.equal(plan.sessionId, "session-1");
  assert.equal(plan.writerEpoch, "epoch-1");
  assert.equal(plan.workspace.layerId, value.currentHandle.layerId);
  assert.equal(plan.previous, null);

  const splitBrain = await fixture();
  await assert.rejects(
    prepare(splitBrain, "local-host-filesystem"),
    (error: unknown) => error instanceof Drive9ProtocolError && error.code === "execution_env_mismatch",
  );
});

test("creates a durable checkpoint then independently verifies exact identity and lineage", async () => {
  const value = await fixture();
  const plan = await prepare(value);
  value.backend.current = { ...value.backend.current!, hasUnpublishedWrites: true };
  const checkpoint = await value.coordinator.checkpointAndVerify(
    checkpointRequest(value, plan),
    BACKGROUND_CONTEXT,
  );
  assert.equal(checkpoint.checkpointId, checkpointRequest(value, plan).checkpointId);
  assert.equal(checkpoint.layerId, value.currentHandle.layerId);
  assert.equal(value.backend.checkpointInputs.length, 1);
  assert.equal(value.backend.checkpointInputs[0]?.writerEpoch, "epoch-1");
  assert.equal(value.backend.checkpointInputs[0]?.previous, null);
});

test("rejects checkpoint verification that only proves existence", async () => {
  const value = await fixture();
  const plan = await prepare(value);
  const request = checkpointRequest(value, plan);
  value.backend.readTransform = (checkpoint) =>
    checkpoint.checkpointId === request.checkpointId
      ? { ...checkpoint, durableSeq: checkpoint.durableSeq + 1 }
      : checkpoint;
  await assert.rejects(
    value.coordinator.checkpointAndVerify(request, BACKGROUND_CONTEXT),
    (error: unknown) => error instanceof Drive9ProtocolError && error.code === "checkpoint_mismatch",
  );
});

test("rejects a stale writer or changed binding before checkpoint creation", async () => {
  const staleEpoch = await fixture();
  const stalePlan = await prepare(staleEpoch);
  markServerFencedStorage(staleEpoch.storage, "epoch-2");
  await assert.rejects(
    staleEpoch.coordinator.checkpointAndVerify(
      checkpointRequest(staleEpoch, stalePlan),
      BACKGROUND_CONTEXT,
    ),
    (error: unknown) => error instanceof Drive9ProtocolError && error.code === "recovery_failed",
  );
  assert.equal(staleEpoch.backend.checkpointInputs.length, 0);

  const changedBinding = await fixture();
  const changedPlan = await prepare(changedBinding);
  changedBinding.backend.current = {
    ...changedBinding.backend.current!,
    handle: handle("layer-replaced"),
  };
  await assert.rejects(
    changedBinding.coordinator.checkpointAndVerify(
      checkpointRequest(changedBinding, changedPlan),
      BACKGROUND_CONTEXT,
    ),
    (error: unknown) => error instanceof Drive9ProtocolError && error.code === "recovery_failed",
  );
  assert.equal(changedBinding.backend.checkpointInputs.length, 0);
});

test("a tainted generation is recovered before the next mutating tool", async () => {
  const value = await fixture();
  const dirtyPlan = await prepare(value);
  value.coordinator.invalidate(dirtyPlan);
  const replacement = handle("layer-recovered");
  value.backend.forkResults.push({ handle: replacement, hasUnpublishedWrites: false });
  const recoveredPlan = await prepare(value, replacement.executionEnvId);
  assert.equal(recoveredPlan.workspace.layerId, replacement.layerId);
  assert.equal(value.backend.forkInputs.length, 1);
  assert.deepEqual(value.backend.abandoned, [value.currentHandle]);
});

test("poisoning prevents every later mutation from continuing", async () => {
  let observed: Drive9ProtocolError | undefined;
  const value = await fixture({ onPoison: (error) => (observed = error) });
  const unknown = new Drive9ProtocolError("candidate_commit_unknown", "candidate commit response lost");
  await assert.rejects(value.coordinator.poison(unknown, BACKGROUND_CONTEXT), unknown);
  assert.equal(observed, unknown);
  await assert.rejects(
    prepare(value),
    (error: unknown) => error instanceof Drive9ProtocolError && error.code === "session_poisoned",
  );
  assert.equal(value.backend.forkInputs.length, 0);
});

test("initial checkpoint must pass an independent exact read", async () => {
  const value = await fixture();
  value.backend.readTransform = (checkpoint) => ({ ...checkpoint, rootLayerId: "wrong-root" });
  await assert.rejects(
    prepare(value),
    (error: unknown) => error instanceof Drive9ProtocolError && error.code === "checkpoint_mismatch",
  );
});

test("rejects a checkpoint request built from an unissued plan", async () => {
  const value = await fixture();
  const plan = await prepare(value);
  const forged = { ...plan };
  await assert.rejects(
    value.coordinator.checkpointAndVerify(checkpointRequest(value, forged), BACKGROUND_CONTEXT),
    (error: unknown) => error instanceof Drive9ProtocolError && error.code === "recovery_failed",
  );
});

test("binds checkpoint creation to the exact prepared task, call, effect, and attempt identity", async () => {
  const value = await fixture();
  const plan = await prepare(value);
  const request = checkpointRequest(value, plan);
  for (const changed of [
    { ...request, taskId: 3 as TaskId },
    { ...request, toolCallId: "call-other" },
    { ...request, effect: "workspace+external" as const },
    { ...request, checkpointId: "checkpoint-wrong" },
  ]) {
    await assert.rejects(
      value.coordinator.checkpointAndVerify(changed, BACKGROUND_CONTEXT),
      (error: unknown) => error instanceof Drive9ProtocolError,
    );
  }
  assert.equal(value.backend.checkpointInputs.length, 0);
});
