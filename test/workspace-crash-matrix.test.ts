import assert from "node:assert/strict";
import test from "node:test";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  MemoryStorage,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type StorageWrite,
  type TaskId,
  type ToolExecutionApi,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import { Drive9ProtocolError } from "../src/core/errors.js";
import { Drive9WorkspaceCoordinator } from "../src/workspace/coordinator.js";
import {
  WorkspaceAttemptEntry,
  WorkspaceCandidateEntry,
  buildWorkspaceAttemptData,
  buildWorkspaceCandidateData,
  deriveWorkspaceCandidateKey,
} from "../src/workspace/entries.js";
import { resolvePublishedWorkspace } from "../src/workspace/publication.js";
import {
  recoverWorkspace,
  type WorkspaceBinding,
  type WritableWorkspaceHandle,
} from "../src/workspace/recovery.js";
import type {
  PublishedWorkspaceRef,
  VerifiedWorkspaceCheckpoint,
  WorkspaceCandidateData,
  WorkspaceMutationPlan,
} from "../src/workspace/types.js";
import { withDrive9Effects } from "../src/workspace/wrap-tool.js";

type CrashPoint = "T0" | "T1" | "T2" | "T3" | "T4" | "T5" | "T6" | "T7";

type Layer = {
  readonly handle: WritableWorkspaceHandle;
  bytes: string;
  dirty: boolean;
  abandoned: boolean;
};

type StoredCheckpoint = {
  readonly checkpoint: VerifiedWorkspaceCheckpoint;
  readonly bytes: string;
};

const epoch = "epoch-preview";

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

class CrashWorkspaceBackend {
  readonly conversationId: ConversationId;
  readonly initialCheckpoint: VerifiedWorkspaceCheckpoint;
  readonly layers = new Map<string, Layer>();
  readonly checkpoints = new Map<string, StoredCheckpoint>();
  readonly abandoned = new Set<string>();
  binding: WorkspaceBinding;
  #durableSeq = 1;

  constructor(conversationId: ConversationId) {
    this.conversationId = conversationId;
    const rootHandle: WritableWorkspaceHandle = {
      layerId: "root-layer",
      rootLayerId: "root-layer",
      parentLayerId: null,
      parentCheckpointId: null,
      sourceCheckpointId: "checkpoint-initial",
      depth: 0,
      executionEnvId: "drive9-layer:root-layer",
    };
    this.layers.set(rootHandle.layerId, {
      handle: rootHandle,
      bytes: "A",
      dirty: false,
      abandoned: false,
    });
    this.initialCheckpoint = {
      checkpointId: "checkpoint-initial",
      durableSeq: this.#durableSeq,
      layerId: rootHandle.layerId,
      rootLayerId: rootHandle.rootLayerId,
      parentLayerId: rootHandle.parentLayerId,
      parentCheckpointId: rootHandle.parentCheckpointId,
      depth: rootHandle.depth,
    };
    this.checkpoints.set(this.initialCheckpoint.checkpointId, {
      checkpoint: this.initialCheckpoint,
      bytes: "A",
    });

    const working = this.#fork(this.initialCheckpoint, "working-layer");
    this.binding = {
      conversationId,
      writerEpoch: epoch,
      publishedCandidateKey: null,
      handle: working.handle,
      hasUnpublishedWrites: false,
    };
  }

  bytes(layerId = this.binding.handle.layerId): string {
    return this.#layer(layerId).bytes;
  }

  mutate(bytes: string): void {
    const layer = this.#layer(this.binding.handle.layerId);
    layer.bytes = bytes;
    layer.dirty = true;
  }

  async currentBinding(conversationId: ConversationId): Promise<WorkspaceBinding | undefined> {
    if (Number(conversationId) !== Number(this.conversationId)) return undefined;
    const layer = this.#layer(this.binding.handle.layerId);
    return { ...this.binding, hasUnpublishedWrites: layer.dirty || layer.abandoned };
  }

  async forkFromCheckpoint(input: {
    readonly source: VerifiedWorkspaceCheckpoint;
    readonly childIdentity: string;
    readonly writerEpoch: string;
  }): Promise<{ readonly handle: WritableWorkspaceHandle; readonly hasUnpublishedWrites: boolean }> {
    assert.equal(input.writerEpoch, epoch);
    const persisted = this.#checkpoint(input.source.checkpointId);
    assert.deepEqual(persisted.checkpoint, input.source);
    const existing = this.layers.get(input.childIdentity);
    if (existing !== undefined) {
      return { handle: existing.handle, hasUnpublishedWrites: existing.dirty || existing.abandoned };
    }
    const layer = this.#fork(input.source, input.childIdentity);
    return { handle: layer.handle, hasUnpublishedWrites: false };
  }

  async switchBinding(input: {
    readonly conversationId: ConversationId;
    readonly writerEpoch: string;
    readonly expectedLayerId: string | null;
    readonly publishedCandidateKey: string | null;
    readonly handle: WritableWorkspaceHandle;
  }): Promise<void> {
    assert.equal(Number(input.conversationId), Number(this.conversationId));
    assert.equal(input.writerEpoch, epoch);
    assert.equal(input.expectedLayerId, this.binding.handle.layerId);
    assert.deepEqual(this.#layer(input.handle.layerId).handle, input.handle);
    this.binding = {
      conversationId: input.conversationId,
      writerEpoch: input.writerEpoch,
      publishedCandidateKey: input.publishedCandidateKey,
      handle: input.handle,
      hasUnpublishedWrites: false,
    };
  }

  async abandon(handle: WritableWorkspaceHandle): Promise<void> {
    const layer = this.#layer(handle.layerId);
    layer.abandoned = true;
    this.abandoned.add(handle.layerId);
  }

  async checkpoint(input: {
    readonly handle: WritableWorkspaceHandle;
    readonly checkpointId: string;
  }): Promise<VerifiedWorkspaceCheckpoint> {
    const existing = this.checkpoints.get(input.checkpointId);
    if (existing !== undefined) return existing.checkpoint;
    const layer = this.#layer(input.handle.layerId);
    assert.deepEqual(layer.handle, input.handle);
    const checkpoint: VerifiedWorkspaceCheckpoint = {
      checkpointId: input.checkpointId,
      durableSeq: ++this.#durableSeq,
      layerId: input.handle.layerId,
      rootLayerId: input.handle.rootLayerId,
      parentLayerId: input.handle.parentLayerId,
      parentCheckpointId: input.handle.parentCheckpointId,
      depth: input.handle.depth,
    };
    this.checkpoints.set(checkpoint.checkpointId, { checkpoint, bytes: layer.bytes });
    return checkpoint;
  }

  async readCheckpoint(input: {
    readonly checkpointId: string;
    readonly layerId: string;
  }): Promise<VerifiedWorkspaceCheckpoint> {
    const stored = this.#checkpoint(input.checkpointId);
    if (stored.checkpoint.layerId !== input.layerId) {
      throw new Drive9ProtocolError("checkpoint_mismatch", "checkpoint belongs to another layer");
    }
    return stored.checkpoint;
  }

  async verify(candidate: WorkspaceCandidateData): Promise<VerifiedWorkspaceCheckpoint> {
    return await this.readCheckpoint({
      checkpointId: candidate.checkpoint.checkpointId,
      layerId: candidate.checkpoint.layerId,
    });
  }

  #fork(source: VerifiedWorkspaceCheckpoint, layerId: string): Layer {
    const stored = this.#checkpoint(source.checkpointId);
    const handle: WritableWorkspaceHandle = {
      layerId,
      rootLayerId: source.rootLayerId,
      parentLayerId: source.layerId,
      parentCheckpointId: source.checkpointId,
      sourceCheckpointId: source.checkpointId,
      depth: source.depth + 1,
      executionEnvId: `drive9-layer:${layerId}`,
    };
    const layer = { handle, bytes: stored.bytes, dirty: false, abandoned: false };
    this.layers.set(layerId, layer);
    return layer;
  }

  #layer(layerId: string): Layer {
    const layer = this.layers.get(layerId);
    if (layer === undefined) throw new Error(`missing layer: ${layerId}`);
    return layer;
  }

  #checkpoint(checkpointId: string): StoredCheckpoint {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (checkpoint === undefined) throw new Error(`missing checkpoint: ${checkpointId}`);
    return checkpoint;
  }
}

async function commit(storage: MemoryStorage, writes: readonly StorageWrite[]): Promise<void> {
  await storage.commit(writes, BACKGROUND_CONTEXT);
}

async function createRunningTask(
  storage: MemoryStorage,
  conversationId: ConversationId,
  callId: string,
): Promise<TaskId<JsonValue>> {
  const taskId = await storage.mintId<TaskId<JsonValue>>();
  await commit(storage, [
    {
      type: "task",
      value: {
        id: taskId,
        conversationId,
        kind: "pi.tool",
        version: 1,
        input: { assistant: 1, callId },
        background: false,
        abortRequested: false,
        state: { status: "running", checkpoint: {} },
      },
    },
  ]);
  return taskId;
}

async function appendEntry(
  storage: MemoryStorage,
  conversationId: ConversationId,
  taskId: TaskId,
  kind: string,
  data?: JsonValue,
): Promise<EntryRecord> {
  const id = await storage.mintId<EntryId>();
  const entry: EntryRecord = {
    id,
    conversationId,
    kind,
    ...(data === undefined ? {} : { data }),
    byTaskId: taskId,
  };
  await commit(storage, [{ type: "entry", value: entry }]);
  return entry;
}

async function appendResultAndSettle(
  storage: MemoryStorage,
  conversationId: ConversationId,
  taskId: TaskId<JsonValue>,
  callId: string,
): Promise<EntryId> {
  const resultId = await storage.mintId<EntryId>();
  await commit(storage, [
    {
      type: "entry",
      value: {
        id: resultId,
        conversationId,
        kind: "pi.tool-result",
        model: [
          {
            role: "toolResult",
            toolCallId: callId,
            toolName: "write",
            content: [],
            isError: false,
            timestamp: 1,
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
        conversationId,
        kind: "pi.tool",
        version: 1,
        input: { assistant: 1, callId },
        background: false,
        abortRequested: false,
        state: { status: "terminal", outcome: { status: "completed", result: { entryId: resultId } } },
      },
    },
  ]);
  return resultId;
}

async function crashFixture(point: CrashPoint) {
  const storage = new MemoryStorage();
  const conversationId = await storage.mintId<ConversationId>();
  await commit(storage, [{ type: "conversation", value: { id: conversationId } }]);
  const backend = new CrashWorkspaceBackend(conversationId);
  const callId = "call-crash";
  const taskId = await createRunningTask(storage, conversationId, callId);
  const plan: WorkspaceMutationPlan = {
    sessionId: "session-crash",
    writerEpoch: epoch,
    workspace: {
      layerId: backend.binding.handle.layerId,
      rootLayerId: backend.binding.handle.rootLayerId,
      parentLayerId: backend.binding.handle.parentLayerId,
      parentCheckpointId: backend.binding.handle.parentCheckpointId,
      depth: backend.binding.handle.depth,
      executionEnvId: backend.binding.handle.executionEnvId,
    },
    previous: null,
  };
  const state = { storage, conversationId, backend, taskId, callId };
  if (point === "T0") return state;

  const attempt = buildWorkspaceAttemptData({
    conversationId: Number(conversationId),
    taskId: Number(taskId),
    toolCallId: callId,
    effect: "workspace",
    plan,
  });
  const attemptEntry = await appendEntry(
    storage,
    conversationId,
    taskId,
    WorkspaceAttemptEntry.kind,
    attempt as JsonValue,
  );
  if (point === "T1") return state;

  backend.mutate(point === "T2" ? "B-partial" : "B");
  if (point === "T2" || point === "T3") return state;

  const checkpointId = deriveWorkspaceCandidateKey(attempt, attemptEntry.id);
  const checkpoint = await backend.checkpoint({ handle: backend.binding.handle, checkpointId });
  if (point === "T4") return state;

  const candidate = buildWorkspaceCandidateData({ attempt, attemptId: attemptEntry.id, checkpoint });
  await appendEntry(
    storage,
    conversationId,
    taskId,
    WorkspaceCandidateEntry.kind,
    candidate as JsonValue,
  );
  if (point === "T5" || point === "T6") return state;

  await appendResultAndSettle(storage, conversationId, taskId, callId);
  return state;
}

async function recover(value: Awaited<ReturnType<typeof crashFixture>>) {
  return await recoverWorkspace({
    storage: value.storage,
    conversationId: value.conversationId,
    expectedSessionId: "session-crash",
    initialCheckpoint: value.backend.initialCheckpoint,
    verifier: value.backend,
    backend: value.backend,
    context: BACKGROUND_CONTEXT,
    maxLayerDepth: 16,
    mode: { kind: "single-coordinator-preview", writerEpoch: epoch },
  });
}

async function toolCommit<T>(
  storage: MemoryStorage,
  conversationId: ConversationId,
  taskId: TaskId,
  change: (transaction: Tx) => T | Promise<T>,
): Promise<T> {
  const writes: StorageWrite[] = [];
  const transaction = {
    appendEntry: async (...args: unknown[]) => {
      const token = args[0] as { readonly kind: string };
      const selectedConversationId = args[1] as ConversationId;
      const draft = args[2] as { readonly data?: JsonValue };
      assert.equal(Number(selectedConversationId), Number(conversationId));
      const id = await storage.mintId<EntryId>();
      const entry: EntryRecord = {
        id,
        conversationId,
        kind: token.kind,
        ...(draft.data === undefined ? {} : { data: draft.data }),
        byTaskId: taskId,
      };
      writes.push({ type: "entry", value: entry });
      return entry;
    },
  } as unknown as Tx;
  const result = await change(transaction);
  await commit(storage, writes);
  return result;
}

async function runNextMutation(value: Awaited<ReturnType<typeof crashFixture>>, expectedBase: string): Promise<void> {
  const current = await value.backend.currentBinding(value.conversationId);
  assert.ok(current);
  const callId = "call-next";
  const taskId = await createRunningTask(value.storage, value.conversationId, callId);
  const coordinator = new Drive9WorkspaceCoordinator({
    sessionId: "session-crash",
    storage: value.storage,
    backend: value.backend,
    initialCheckpoint: async () => value.backend.initialCheckpoint,
    maxLayerDepth: 16,
    mode: { kind: "single-coordinator-preview", writerEpoch: epoch },
  });
  const tool = {
    name: "write",
    label: "write",
    description: "write",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      assert.equal(value.backend.bytes(), expectedBase);
      value.backend.mutate(`${expectedBase}-next`);
      return { content: [] };
    },
  } as unknown as ToolRegistration;
  const wrapped = withDrive9Effects(tool, { coordinator, effect: "workspace" });
  const api = {
    taskId,
    conversationId: value.conversationId,
    callId,
    env: { id: current.handle.executionEnvId },
    commit: async <T>(change: (transaction: Tx) => T | Promise<T>, _context: Context) =>
      await toolCommit(value.storage, value.conversationId, taskId, change),
  } as unknown as ToolExecutionApi;

  const result = await wrapped.execute({}, api, BACKGROUND_CONTEXT);
  assert.equal(result.isError, undefined);
  await appendResultAndSettle(value.storage, value.conversationId, taskId, callId);

  const after = await recover(value);
  assert.equal(value.backend.bytes(after.binding.handle.layerId), `${expectedBase}-next`);
  const published = await resolvePublishedWorkspace({
    storage: value.storage,
    conversationId: value.conversationId,
    verifier: value.backend,
    context: BACKGROUND_CONTEXT,
  });
  assert.equal(published?.data.checkpoint.checkpointId, after.binding.handle.sourceCheckpointId);
}

for (const point of ["T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7"] as const) {
  test(`${point} restart exposes only the published workspace and the next mutation uses that baseline`, async () => {
    const value = await crashFixture(point);
    const expected = point === "T7" ? "B" : "A";
    const recovered = await recover(value);

    assert.equal(value.backend.bytes(recovered.binding.handle.layerId), expected);
    assert.equal(recovered.published === undefined, point !== "T7");
    if (point === "T4") assert.equal(value.backend.checkpoints.size, 2, "orphan checkpoint must be retained");
    if (point === "T5" || point === "T6") {
      assert.equal(value.backend.checkpoints.size, 2, "candidate checkpoint must remain an unpublished orphan");
    }

    await runNextMutation(value, expected);
  });
}

test("terminal success without its durable candidate fails closed instead of rolling back silently", async () => {
  const value = await crashFixture("T4");
  const originalLayerId = value.backend.binding.handle.layerId;
  await appendResultAndSettle(value.storage, value.conversationId, value.taskId, value.callId);

  await assert.rejects(
    recover(value),
    (error: unknown) =>
      error instanceof Drive9ProtocolError &&
      error.code === "publication_breach" &&
      error.message.includes("no candidate"),
  );
  assert.equal(value.backend.binding.handle.layerId, originalLayerId);
  assert.equal(value.backend.bytes(), "B");
  assert.equal(value.backend.abandoned.size, 0);
});

test("workspace tool success cannot become visible before candidate commit acknowledgement", async () => {
  const plan: WorkspaceMutationPlan = {
    sessionId: "session-ordering",
    writerEpoch: epoch,
    workspace: {
      layerId: "ordering-layer",
      rootLayerId: "ordering-root",
      parentLayerId: "ordering-parent",
      parentCheckpointId: "ordering-parent-checkpoint",
      depth: 1,
      executionEnvId: "drive9-layer:ordering-layer",
    },
    previous: null,
  };
  let releaseCandidate!: () => void;
  const candidateGate = new Promise<void>((resolve) => {
    releaseCandidate = resolve;
  });
  let candidateStarted!: () => void;
  const candidateStart = new Promise<void>((resolve) => {
    candidateStarted = resolve;
  });
  let commitCount = 0;
  let nextEntryId = 1;
  let candidateDurable = false;
  const conversationId = 1 as ConversationId;
  const taskId = 1 as TaskId;
  const transaction = {
    appendEntry: async (...args: unknown[]) => {
      const token = args[0] as { readonly kind: string };
      const draft = args[2] as { readonly data?: JsonValue };
      return {
        id: nextEntryId++ as EntryId,
        conversationId,
        kind: token.kind,
        ...(draft.data === undefined ? {} : { data: draft.data }),
        byTaskId: taskId,
      } as EntryRecord;
    },
  } as unknown as Tx;
  const api = {
    taskId,
    conversationId,
    callId: "call-ordering",
    env: { id: plan.workspace.executionEnvId },
    commit: async <T>(change: (tx: Tx) => T | Promise<T>) => {
      commitCount += 1;
      const result = await change(transaction);
      if (commitCount === 2) {
        candidateStarted();
        await candidateGate;
        candidateDurable = true;
      }
      return result;
    },
  } as unknown as ToolExecutionApi;
  const coordinator = {
    prepare: async () => plan,
    checkpointAndVerify: async (request: { readonly checkpointId: string }) => ({
      checkpointId: request.checkpointId,
      durableSeq: 2,
      layerId: plan.workspace.layerId,
      rootLayerId: plan.workspace.rootLayerId,
      parentLayerId: plan.workspace.parentLayerId,
      parentCheckpointId: plan.workspace.parentCheckpointId,
      depth: plan.workspace.depth,
    }),
    invalidate: () => undefined,
    poison: async (error: Error) => {
      throw error;
    },
  };
  const wrapped = withDrive9Effects(
    {
      name: "write",
      label: "write",
      description: "write",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [] }),
    } as unknown as ToolRegistration,
    { coordinator, effect: "workspace" },
  );

  let settled = false;
  const execution = wrapped.execute({}, api, BACKGROUND_CONTEXT).then((result) => {
    settled = true;
    return result;
  });
  await Promise.race([
    candidateStart,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("candidate commit did not start")), 250)),
  ]);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(candidateDurable, false);

  releaseCandidate();
  const result = await execution;
  assert.equal(result.isError, undefined);
  assert.equal(candidateDurable, true);
  assert.equal(commitCount, 2);
});
