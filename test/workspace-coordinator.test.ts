import assert from "node:assert/strict";
import test from "node:test";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  MemoryStorage,
  type ConversationId,
  type EntryId,
  type Storage,
  type StorageWrite,
  type TaskId,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Drive9ProtocolError } from "../src/core/errors.js";
import { markServerFencedStorage } from "../src/storage/profile.js";
import {
  WorkspaceAttemptEntry,
  WorkspaceCandidateEntry,
  buildWorkspaceAttemptData,
  buildWorkspaceCandidateData,
  deriveWorkspaceCandidateKey,
} from "../src/workspace/entries.js";
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
  PublishedWorkspaceRef,
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

async function commit(storage: MemoryStorage, writes: readonly StorageWrite[]): Promise<void> {
  await storage.commit(writes, BACKGROUND_CONTEXT);
}

function publishedRef(candidate: WorkspaceCandidateData): PublishedWorkspaceRef {
  return {
    candidateKey: candidate.candidateKey,
    checkpointId: candidate.checkpoint.checkpointId,
    durableSeq: candidate.checkpoint.durableSeq,
    layerId: candidate.checkpoint.layerId,
    rootLayerId: candidate.checkpoint.rootLayerId,
    depth: candidate.checkpoint.depth,
  };
}

function withEntryScan(storage: Storage, scanEntries: Storage["scanEntries"]): Storage {
  return new Proxy(storage, {
    get(target, property) {
      if (property === "scanEntries") return scanEntries;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function withEntryLookup(storage: Storage, entry: Storage["entry"]): Storage {
  return new Proxy(storage, {
    get(target, property) {
      if (property === "entry") return entry;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function appendPublishedSuccess(input: {
  readonly storage: MemoryStorage;
  readonly conversationId: ConversationId;
  readonly backend: FakeBackend;
  readonly plan: WorkspaceMutationPlan;
  readonly toolCallId: string;
  readonly timestamp: number;
}): Promise<{ readonly resultId: EntryId; readonly candidate: WorkspaceCandidateData }> {
  const taskId = await input.storage.mintId<TaskId<JsonValue>>();
  const attemptId = await input.storage.mintId<EntryId>();
  const candidateId = await input.storage.mintId<EntryId>();
  const resultId = await input.storage.mintId<EntryId>();
  const attempt = buildWorkspaceAttemptData({
    conversationId: Number(input.conversationId),
    taskId: Number(taskId),
    toolCallId: input.toolCallId,
    effect: "workspace",
    plan: input.plan,
  });
  const candidate = buildWorkspaceCandidateData({
    attempt,
    attemptId,
    checkpoint: {
      checkpointId: deriveWorkspaceCandidateKey(attempt, attemptId),
      durableSeq: input.timestamp,
      layerId: input.plan.workspace.layerId,
      rootLayerId: input.plan.workspace.rootLayerId,
      parentLayerId: input.plan.workspace.parentLayerId,
      parentCheckpointId: input.plan.workspace.parentCheckpointId,
      depth: input.plan.workspace.depth,
    },
  });
  input.backend.checkpoints.set(candidate.checkpoint.checkpointId, candidate.checkpoint);
  await commit(input.storage, [
    {
      type: "entry",
      value: {
        id: attemptId,
        conversationId: input.conversationId,
        kind: WorkspaceAttemptEntry.kind,
        data: attempt,
        byTaskId: taskId,
      },
    },
    {
      type: "entry",
      value: {
        id: candidateId,
        conversationId: input.conversationId,
        kind: WorkspaceCandidateEntry.kind,
        data: candidate,
        byTaskId: taskId,
      },
    },
    {
      type: "entry",
      value: {
        id: resultId,
        conversationId: input.conversationId,
        kind: "pi.tool-result",
        model: [
          {
            role: "toolResult",
            toolCallId: input.toolCallId,
            toolName: "write",
            content: [],
            isError: false,
            timestamp: input.timestamp,
          },
        ],
        data: { diagnostics: [] },
        byTaskId: taskId,
      },
    },
    {
      type: "task",
      value: {
        id: taskId,
        conversationId: input.conversationId,
        kind: "pi.tool",
        version: 1,
        input: { assistant: input.timestamp, callId: input.toolCallId },
        background: false,
        abortRequested: false,
        state: {
          status: "terminal",
          outcome: { status: "completed", result: { entryId: resultId } },
        },
      },
    },
  ]);
  return { resultId, candidate };
}

async function publishedRootFixture(label: string, timestamp: number) {
  const storage = new MemoryStorage();
  const conversationId = await storage.mintId<ConversationId>();
  await commit(storage, [{ type: "conversation", value: { id: conversationId } }]);
  const backend = new FakeBackend();
  backend.current = undefined;
  const published = await appendPublishedSuccess({
    storage,
    conversationId,
    backend,
    plan: {
      sessionId: "session-1",
      writerEpoch: "epoch-1",
      workspace: {
        layerId: `layer-${label}`,
        rootLayerId: initialCheckpoint.rootLayerId,
        parentLayerId: initialCheckpoint.layerId,
        parentCheckpointId: initialCheckpoint.checkpointId,
        depth: 1,
        executionEnvId: `drive9-layer:layer-${label}`,
      },
      previous: null,
    },
    toolCallId: `call-${label}`,
    timestamp,
  });
  return { storage, conversationId, backend, published };
}

function publicationCoordinator(storage: Storage, backend: FakeBackend): Drive9WorkspaceCoordinator {
  return new Drive9WorkspaceCoordinator({
    sessionId: "session-1",
    storage,
    backend,
    initialCheckpoint: async () => initialCheckpoint,
    maxLayerDepth: 16,
    mode: { kind: "stable" },
  });
}

async function prepareConversation(
  coordinator: Drive9WorkspaceCoordinator,
  conversationId: ConversationId,
  executionEnvId = "drive9-layer:unused",
) {
  return coordinator.prepare(
    {
      conversationId,
      taskId: 99 as TaskId,
      toolCallId: "call-next",
      effect: "workspace",
      env: environment(executionEnvId),
    },
    BACKGROUND_CONTEXT,
  );
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

test("a child coordinator inherits only the published workspace visible at its fork cutoff", async () => {
  const storage = new MemoryStorage();
  const parentId = await storage.mintId<ConversationId>();
  await commit(storage, [{ type: "conversation", value: { id: parentId } }]);
  markServerFencedStorage(storage, "epoch-1");
  const backend = new FakeBackend();
  backend.current = undefined;
  const firstPlan: WorkspaceMutationPlan = {
    sessionId: "session-1",
    writerEpoch: "epoch-1",
    workspace: {
      layerId: "layer-parent-first",
      rootLayerId: initialCheckpoint.rootLayerId,
      parentLayerId: initialCheckpoint.layerId,
      parentCheckpointId: initialCheckpoint.checkpointId,
      depth: 1,
      executionEnvId: "drive9-layer:layer-parent-first",
    },
    previous: null,
  };
  const first = await appendPublishedSuccess({
    storage,
    conversationId: parentId,
    backend,
    plan: firstPlan,
    toolCallId: "call-parent-first",
    timestamp: 11,
  });
  const childId = await storage.mintId<ConversationId>();
  await commit(storage, [
    {
      type: "conversation",
      value: { id: childId, parent: { conversationId: parentId, at: first.resultId } },
    },
  ]);
  const laterPlan: WorkspaceMutationPlan = {
    sessionId: "session-1",
    writerEpoch: "epoch-1",
    workspace: {
      layerId: "layer-parent-later",
      rootLayerId: initialCheckpoint.rootLayerId,
      parentLayerId: first.candidate.checkpoint.layerId,
      parentCheckpointId: first.candidate.checkpoint.checkpointId,
      depth: 2,
      executionEnvId: "drive9-layer:layer-parent-later",
    },
    previous: publishedRef(first.candidate),
  };
  await appendPublishedSuccess({
    storage,
    conversationId: parentId,
    backend,
    plan: laterPlan,
    toolCallId: "call-parent-later",
    timestamp: 12,
  });

  const childHandle: WritableWorkspaceHandle = {
    layerId: "layer-child",
    rootLayerId: initialCheckpoint.rootLayerId,
    parentLayerId: first.candidate.checkpoint.layerId,
    parentCheckpointId: first.candidate.checkpoint.checkpointId,
    sourceCheckpointId: first.candidate.checkpoint.checkpointId,
    depth: first.candidate.checkpoint.depth + 1,
    executionEnvId: "drive9-layer:layer-child",
  };
  backend.forkResults.push({ handle: childHandle, hasUnpublishedWrites: false });
  const plan = await prepareConversation(
    publicationCoordinator(storage, backend),
    childId,
    childHandle.executionEnvId,
  );

  assert.equal(backend.forkInputs.length, 1);
  assert.deepEqual(backend.forkInputs[0]?.source, first.candidate.checkpoint);
  assert.equal(backend.switchInputs[0]?.conversationId, childId);
  assert.equal(plan.workspace.layerId, childHandle.layerId);
  assert.deepEqual(plan.previous, publishedRef(first.candidate));
});

test("rejects a published candidate injected from an unrelated conversation before workspace mutation", async () => {
  const base = new MemoryStorage();
  const childId = await base.mintId<ConversationId>();
  const unrelatedId = await base.mintId<ConversationId>();
  await commit(base, [
    { type: "conversation", value: { id: childId } },
    { type: "conversation", value: { id: unrelatedId } },
  ]);
  const backend = new FakeBackend();
  backend.current = undefined;
  await appendPublishedSuccess({
    storage: base,
    conversationId: unrelatedId,
    backend,
    plan: {
      sessionId: "session-1",
      writerEpoch: "epoch-1",
      workspace: {
        layerId: "layer-unrelated",
        rootLayerId: initialCheckpoint.rootLayerId,
        parentLayerId: initialCheckpoint.layerId,
        parentCheckpointId: initialCheckpoint.checkpointId,
        depth: 1,
        executionEnvId: "drive9-layer:layer-unrelated",
      },
      previous: null,
    },
    toolCallId: "call-unrelated",
    timestamp: 21,
  });
  const storage = withEntryScan(base, (_query, limit, cursor, context) =>
    base.scanEntries({ conversationId: unrelatedId }, limit, cursor, context),
  );
  markServerFencedStorage(storage, "epoch-1");

  await assert.rejects(
    prepareConversation(publicationCoordinator(storage, backend), childId),
    (error: unknown) => error instanceof Drive9ProtocolError && error.code === "publication_breach",
  );
  assert.equal(backend.forkInputs.length, 0);
  assert.equal(backend.switchInputs.length, 0);
});

test("rejects a parent candidate injected after the child fork cutoff before workspace mutation", async () => {
  const base = new MemoryStorage();
  const parentId = await base.mintId<ConversationId>();
  await commit(base, [{ type: "conversation", value: { id: parentId } }]);
  const cutoffId = await base.mintId<EntryId>();
  await commit(base, [
    {
      type: "entry",
      value: { id: cutoffId, conversationId: parentId, kind: "test.fork-cutoff" },
    },
  ]);
  const childId = await base.mintId<ConversationId>();
  await commit(base, [
    {
      type: "conversation",
      value: { id: childId, parent: { conversationId: parentId, at: cutoffId } },
    },
  ]);
  const backend = new FakeBackend();
  backend.current = undefined;
  await appendPublishedSuccess({
    storage: base,
    conversationId: parentId,
    backend,
    plan: {
      sessionId: "session-1",
      writerEpoch: "epoch-1",
      workspace: {
        layerId: "layer-post-cutoff",
        rootLayerId: initialCheckpoint.rootLayerId,
        parentLayerId: initialCheckpoint.layerId,
        parentCheckpointId: initialCheckpoint.checkpointId,
        depth: 1,
        executionEnvId: "drive9-layer:layer-post-cutoff",
      },
      previous: null,
    },
    toolCallId: "call-post-cutoff",
    timestamp: 22,
  });
  const storage = withEntryScan(base, (_query, limit, cursor, context) =>
    base.scanEntries({ conversationId: parentId }, limit, cursor, context),
  );
  markServerFencedStorage(storage, "epoch-1");

  await assert.rejects(
    prepareConversation(publicationCoordinator(storage, backend), childId),
    (error: unknown) => error instanceof Drive9ProtocolError && error.code === "publication_breach",
  );
  assert.equal(backend.forkInputs.length, 0);
  assert.equal(backend.switchInputs.length, 0);
});

test("rejects disagreement between the publication scan and point visibility read before workspace mutation", async () => {
  const value = await publishedRootFixture("scan-mismatch", 23);
  const storage = withEntryScan(value.storage, async (query, limit, cursor, context) => {
    const page = await value.storage.scanEntries(query, limit, cursor, context);
    return {
      ...page,
      items: page.items.map((entry) =>
        entry.id === value.published.resultId ? { ...entry, data: { diagnostics: ["tampered"] } } : entry,
      ),
    };
  });
  markServerFencedStorage(storage, "epoch-1");

  await assert.rejects(
    prepareConversation(publicationCoordinator(storage, value.backend), value.conversationId),
    (error: unknown) => error instanceof Drive9ProtocolError && error.code === "publication_breach",
  );
  assert.equal(value.backend.forkInputs.length, 0);
  assert.equal(value.backend.switchInputs.length, 0);
});

test("fails closed when the point visibility read errors before workspace mutation", async () => {
  const value = await publishedRootFixture("visibility-error", 24);
  const storage = withEntryLookup(
    value.storage,
    (async () => {
      throw new Error("point visibility unavailable");
    }) as Storage["entry"],
  );
  markServerFencedStorage(storage, "epoch-1");

  await assert.rejects(
    prepareConversation(publicationCoordinator(storage, value.backend), value.conversationId),
    /point visibility unavailable/,
  );
  assert.equal(value.backend.forkInputs.length, 0);
  assert.equal(value.backend.switchInputs.length, 0);
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
