import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  MemoryStorage,
  type ConversationId,
  type EntryId,
  type StorageWrite,
  type TaskId,
} from "@earendil-works/pi-durable";
import { Drive9ProtocolError } from "../src/core/errors.js";
import {
  WorkspaceAttemptEntry,
  WorkspaceCandidateEntry,
  buildWorkspaceAttemptData,
  buildWorkspaceCandidateData,
  deriveWorkspaceCandidateKey,
} from "../src/workspace/entries.js";
import {
  inspectWorkspaceCandidateInventory,
  reportWorkspaceCandidateInventory,
} from "../src/workspace/orphans.js";
import type {
  PublishedWorkspaceRef,
  WorkspaceCandidateData,
  WorkspaceMutationPlan,
} from "../src/workspace/types.js";

type Fixture = {
  readonly storage: MemoryStorage;
  readonly conversationId: ConversationId;
};

type CandidateFixture = {
  readonly taskId: TaskId<JsonValue>;
  readonly attemptId: EntryId;
  readonly candidate: WorkspaceCandidateData;
  readonly candidateIds: readonly EntryId[];
  readonly resultId?: EntryId;
};

const baseWorkspace = {
  layerId: "layer-root-work",
  rootLayerId: "layer-root",
  parentLayerId: "layer-root",
  parentCheckpointId: "checkpoint-root",
  depth: 1,
  executionEnvId: "drive9-layer:layer-root-work",
} as const;

async function fixture(): Promise<Fixture> {
  const storage = new MemoryStorage();
  const conversationId = await storage.mintId<ConversationId>();
  await storage.commit([{ type: "conversation", value: { id: conversationId } }], BACKGROUND_CONTEXT);
  return { storage, conversationId };
}

function ref(candidate: WorkspaceCandidateData): PublishedWorkspaceRef {
  return {
    candidateKey: candidate.candidateKey,
    checkpointId: candidate.checkpoint.checkpointId,
    durableSeq: candidate.checkpoint.durableSeq,
    layerId: candidate.checkpoint.layerId,
    rootLayerId: candidate.checkpoint.rootLayerId,
    depth: candidate.checkpoint.depth,
  };
}

async function appendCandidate(
  value: Fixture,
  options: {
    readonly toolCallId: string;
    readonly state: "running" | "completed" | "failed" | "aborted";
    readonly previous?: PublishedWorkspaceRef | null;
    readonly resultIsError?: boolean;
    readonly duplicate?: "identical" | "conflict";
    readonly includeAttempt?: boolean;
    readonly taskId?: TaskId<JsonValue>;
    readonly workspaceSuffix?: string;
  },
): Promise<CandidateFixture> {
  const taskId = options.taskId ?? (await value.storage.mintId<TaskId<JsonValue>>());
  const attemptId = await value.storage.mintId<EntryId>();
  const candidateId = await value.storage.mintId<EntryId>();
  const duplicateId = options.duplicate === undefined ? undefined : await value.storage.mintId<EntryId>();
  const resultId = options.state === "running" ? undefined : await value.storage.mintId<EntryId>();
  const suffix = options.workspaceSuffix ?? options.toolCallId;
  const plan: WorkspaceMutationPlan = {
    sessionId: "session-1",
    writerEpoch: "epoch-1",
    workspace: {
      ...baseWorkspace,
      layerId: `layer-${suffix}`,
      executionEnvId: `drive9-layer:layer-${suffix}`,
    },
    previous: options.previous ?? null,
  };
  const attempt = buildWorkspaceAttemptData({
    conversationId: Number(value.conversationId),
    taskId: Number(taskId),
    toolCallId: options.toolCallId,
    effect: "workspace",
    plan,
  });
  const candidate = buildWorkspaceCandidateData({
    attempt,
    attemptId,
    checkpoint: {
      checkpointId: deriveWorkspaceCandidateKey(attempt, attemptId),
      durableSeq: Number(candidateId),
      layerId: plan.workspace.layerId,
      rootLayerId: plan.workspace.rootLayerId,
      parentLayerId: plan.workspace.parentLayerId,
      parentCheckpointId: plan.workspace.parentCheckpointId,
      depth: plan.workspace.depth,
    },
  });
  const conflicting = buildWorkspaceCandidateData({
    attempt,
    attemptId,
    checkpoint: { ...candidate.checkpoint, durableSeq: candidate.checkpoint.durableSeq + 1 },
  });
  const writes: StorageWrite[] = [];
  if (options.includeAttempt !== false) {
    writes.push({
      type: "entry",
      value: {
        id: attemptId,
        conversationId: value.conversationId,
        kind: WorkspaceAttemptEntry.kind,
        data: attempt,
        byTaskId: taskId,
      },
    });
  }
  writes.push({
    type: "entry",
    value: {
      id: candidateId,
      conversationId: value.conversationId,
      kind: WorkspaceCandidateEntry.kind,
      data: candidate,
      byTaskId: taskId,
    },
  });
  if (duplicateId !== undefined) {
    writes.push({
      type: "entry",
      value: {
        id: duplicateId,
        conversationId: value.conversationId,
        kind: WorkspaceCandidateEntry.kind,
        data: options.duplicate === "conflict" ? conflicting : candidate,
        byTaskId: taskId,
      },
    });
  }
  if (resultId !== undefined) {
    writes.push({
      type: "entry",
      value: {
        id: resultId,
        conversationId: value.conversationId,
        kind: "pi.tool-result",
        model: [
          {
            role: "toolResult",
            toolCallId: options.toolCallId,
            toolName: "write",
            content: [],
            isError: options.resultIsError ?? false,
            timestamp: 1,
          },
        ],
        data: { diagnostics: [] },
        byTaskId: taskId,
      },
    });
  }
  const taskBase = {
    id: taskId,
    conversationId: value.conversationId,
    kind: "pi.tool",
    version: 1,
    input: { assistant: 1, callId: options.toolCallId },
    background: false,
    abortRequested: false,
  } as const;
  if (options.state === "running") {
    writes.push({ type: "task", value: { ...taskBase, state: { status: "running", checkpoint: {} } } });
  } else if (options.state === "completed") {
    writes.push({
      type: "task",
      value: {
        ...taskBase,
        state: { status: "terminal", outcome: { status: "completed", result: { entryId: resultId! } } },
      },
    });
  } else if (options.state === "failed") {
    writes.push({
      type: "task",
      value: {
        ...taskBase,
        state: {
          status: "terminal",
          outcome: { status: "failed", error: { message: "failed" }, result: { entryId: resultId! } },
        },
      },
    });
  } else {
    writes.push({
      type: "task",
      value: {
        ...taskBase,
        state: { status: "terminal", outcome: { status: "aborted", result: { entryId: resultId! } } },
      },
    });
  }
  await value.storage.commit(writes, BACKGROUND_CONTEXT);
  return {
    taskId,
    attemptId,
    candidate,
    candidateIds: duplicateId === undefined ? [candidateId] : [candidateId, duplicateId],
    ...(resultId === undefined ? {} : { resultId }),
  };
}

function verifier() {
  return { verify: async (candidate: WorkspaceCandidateData) => candidate.checkpoint };
}

test("meters published, permanently unpublishable, and unresolved candidates without deleting", async () => {
  const value = await fixture();
  const published = await appendCandidate(value, { toolCallId: "published", state: "completed" });
  const failed = await appendCandidate(value, {
    toolCallId: "failed",
    state: "failed",
    previous: ref(published.candidate),
    duplicate: "identical",
  });
  const active = await appendCandidate(value, {
    toolCallId: "active",
    state: "running",
    previous: ref(published.candidate),
  });

  const inventory = await inspectWorkspaceCandidateInventory({
    ...value,
    expectedSessionId: "session-1",
    verifier: verifier(),
    context: BACKGROUND_CONTEXT,
  });

  assert.equal(inventory.publishedCandidateKey, published.candidate.candidateKey);
  assert.equal(inventory.candidateRecordCount, 4);
  assert.equal(inventory.uniqueCandidateCount, 3);
  assert.equal(inventory.publishedCount, 1);
  assert.equal(inventory.permanentlyUnpublishableCount, 1);
  assert.equal(inventory.unresolvedCount, 1);
  assert.equal(inventory.requiresAttention, true);
  assert.deepEqual(
    inventory.items.find((item) => item.candidateKey === failed.candidate.candidateKey)?.disposition,
    { kind: "permanently-unpublishable", reason: "task-terminal-failed" },
  );
  assert.equal(
    inventory.items.find((item) => item.candidateKey === failed.candidate.candidateKey)?.candidateEntryIds.length,
    2,
  );
  assert.deepEqual(
    inventory.items.find((item) => item.candidateKey === active.candidate.candidateKey)?.disposition,
    { kind: "unresolved", reason: "task-active" },
  );
});

test("marks an error result permanently unpublishable", async () => {
  const value = await fixture();
  const failed = await appendCandidate(value, {
    toolCallId: "error-result",
    state: "completed",
    resultIsError: true,
  });
  const inventory = await inspectWorkspaceCandidateInventory({
    ...value,
    verifier: verifier(),
    context: BACKGROUND_CONTEXT,
  });
  assert.deepEqual(inventory.items[0]?.disposition, {
    kind: "permanently-unpublishable",
    reason: "tool-result-error",
  });
  assert.equal(inventory.items[0]?.candidateKey, failed.candidate.candidateKey);
});

test("counts every verified candidate in the published chain", async () => {
  const value = await fixture();
  const first = await appendCandidate(value, { toolCallId: "first", state: "completed" });
  const second = await appendCandidate(value, {
    toolCallId: "second",
    state: "completed",
    previous: ref(first.candidate),
    workspaceSuffix: "second",
  });
  const inventory = await inspectWorkspaceCandidateInventory({
    ...value,
    verifier: verifier(),
    context: BACKGROUND_CONTEXT,
  });
  assert.equal(inventory.publishedCandidateKey, second.candidate.candidateKey);
  assert.equal(inventory.publishedCount, 2);
  assert.equal(inventory.permanentlyUnpublishableCount, 0);
  assert.equal(inventory.unresolvedCount, 0);
  assert.equal(inventory.requiresAttention, false);
  assert.equal(inventory.items.every((item) => item.disposition.kind === "published"), true);
});

test("retains a terminal success that is not visible at the fork cutoff as unresolved", async () => {
  const value = await fixture();
  const candidate = await appendCandidate(value, { toolCallId: "cutoff", state: "completed" });
  const inventory = await inspectWorkspaceCandidateInventory({
    ...value,
    cutoff: candidate.candidateIds[0]!,
    verifier: verifier(),
    context: BACKGROUND_CONTEXT,
  });
  assert.equal(inventory.publishedCandidateKey, null);
  assert.deepEqual(inventory.items[0]?.disposition, {
    kind: "unresolved",
    reason: "terminal-result-not-visible",
  });
});

test("coalesces identical records and rejects conflicting duplicate candidates", async () => {
  const value = await fixture();
  await appendCandidate(value, { toolCallId: "conflict", state: "failed", duplicate: "conflict" });
  await assert.rejects(
    inspectWorkspaceCandidateInventory({
      ...value,
      verifier: verifier(),
      context: BACKGROUND_CONTEXT,
    }),
    (error: unknown) => error instanceof Drive9ProtocolError && error.code === "candidate_conflict",
  );
});

test("a later successful attempt makes the older candidate permanently unpublishable", async () => {
  const value = await fixture();
  const taskId = await value.storage.mintId<TaskId<JsonValue>>();
  const older = await appendCandidate(value, {
    taskId,
    toolCallId: "retry",
    state: "running",
    workspaceSuffix: "older",
  });
  const newer = await appendCandidate(value, {
    taskId,
    toolCallId: "retry",
    state: "completed",
    workspaceSuffix: "newer",
  });
  const inventory = await inspectWorkspaceCandidateInventory({
    ...value,
    verifier: verifier(),
    context: BACKGROUND_CONTEXT,
  });
  assert.equal(inventory.publishedCandidateKey, newer.candidate.candidateKey);
  assert.deepEqual(
    inventory.items.find((item) => item.candidateKey === older.candidate.candidateKey)?.disposition,
    { kind: "permanently-unpublishable", reason: "terminal-success-not-selected" },
  );
});

test("missing attempt evidence remains unresolved", async () => {
  const value = await fixture();
  await appendCandidate(value, { toolCallId: "missing-attempt", state: "running", includeAttempt: false });
  const inventory = await inspectWorkspaceCandidateInventory({
    ...value,
    verifier: verifier(),
    context: BACKGROUND_CONTEXT,
  });
  assert.deepEqual(inventory.items[0]?.disposition, {
    kind: "unresolved",
    reason: "attempt-not-visible",
  });
});

test("reporting failure does not alter the returned inventory", async () => {
  const value = await fixture();
  const candidate = await appendCandidate(value, { toolCallId: "failed", state: "aborted" });
  const reportError = new Error("metrics unavailable");
  const observedErrors: Error[] = [];
  const inventory = await reportWorkspaceCandidateInventory({
    ...value,
    verifier: verifier(),
    context: BACKGROUND_CONTEXT,
    report: async () => {
      throw reportError;
    },
    onReportError: async (error) => {
      observedErrors.push(error);
      throw new Error("diagnostic sink unavailable");
    },
  });
  assert.equal(inventory.items[0]?.candidateKey, candidate.candidate.candidateKey);
  assert.deepEqual(inventory.items[0]?.disposition, {
    kind: "permanently-unpublishable",
    reason: "task-terminal-aborted",
  });
  assert.deepEqual(observedErrors, [reportError]);
});
