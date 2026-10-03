import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  MemoryStorage,
  type ConversationId,
  type EntryId,
  type EntryRecord,
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
import { resolvePublishedWorkspace } from "../src/workspace/publication.js";
import type {
  VerifiedWorkspaceCheckpoint,
  PublishedWorkspaceRef,
  WorkspaceCandidateData,
  WorkspaceMutationPlan,
} from "../src/workspace/types.js";

type Fixture = {
  storage: MemoryStorage;
  conversationId: ConversationId;
  taskId: TaskId<JsonValue>;
  attemptId: EntryId;
  candidateId: EntryId;
  resultId: EntryId;
  candidate: WorkspaceCandidateData;
};

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

const plan: WorkspaceMutationPlan = {
  sessionId: "session-1",
  writerEpoch: "epoch-1",
  workspace: {
    layerId: "layer-1",
    rootLayerId: "root-1",
    parentLayerId: "parent-1",
    parentCheckpointId: "parent-checkpoint-1",
    depth: 2,
    executionEnvId: "drive9-layer:layer-1",
  },
  previous: null,
};

async function commit(storage: MemoryStorage, writes: readonly StorageWrite[]): Promise<void> {
  await storage.commit(writes, BACKGROUND_CONTEXT);
}

async function fixture(options?: {
  resultIsError?: boolean;
  outcome?: "completed" | "failed";
  duplicateCandidate?: "identical" | "conflict";
}): Promise<Fixture> {
  const storage = new MemoryStorage();
  const conversationId = await storage.mintId<ConversationId>();
  await commit(storage, [{ type: "conversation", value: { id: conversationId } }]);
  const taskId = await storage.mintId<TaskId<JsonValue>>();
  const attemptId = await storage.mintId<EntryId>();
  const candidateId = await storage.mintId<EntryId>();
  const duplicateId = options?.duplicateCandidate === undefined ? undefined : await storage.mintId<EntryId>();
  const resultId = await storage.mintId<EntryId>();
  const attempt = buildWorkspaceAttemptData({
    conversationId: Number(conversationId),
    taskId: Number(taskId),
    toolCallId: "call-1",
    effect: "workspace",
    plan,
  });
  const checkpoint: VerifiedWorkspaceCheckpoint = {
    checkpointId: deriveWorkspaceCandidateKey(attempt, attemptId),
    durableSeq: 42,
    layerId: plan.workspace.layerId,
    rootLayerId: plan.workspace.rootLayerId,
    parentLayerId: plan.workspace.parentLayerId,
    parentCheckpointId: plan.workspace.parentCheckpointId,
    depth: plan.workspace.depth,
  };
  const candidate = buildWorkspaceCandidateData({ attempt, attemptId, checkpoint });
  const duplicateCandidate =
    options?.duplicateCandidate === "conflict"
      ? buildWorkspaceCandidateData({
          attempt,
          attemptId,
          checkpoint: { ...checkpoint, durableSeq: checkpoint.durableSeq + 1 },
        })
      : candidate;
  const entries: StorageWrite[] = [
    {
      type: "entry",
      value: {
        id: attemptId,
        conversationId,
        kind: WorkspaceAttemptEntry.kind,
        data: attempt,
        byTaskId: taskId,
      },
    },
    {
      type: "entry",
      value: {
        id: candidateId,
        conversationId,
        kind: WorkspaceCandidateEntry.kind,
        data: candidate,
        byTaskId: taskId,
      },
    },
  ];
  if (duplicateId !== undefined) {
    entries.push({
      type: "entry",
      value: {
        id: duplicateId,
        conversationId,
        kind: WorkspaceCandidateEntry.kind,
        data: duplicateCandidate,
        byTaskId: taskId,
      },
    });
  }
  entries.push({
    type: "entry",
    value: {
      id: resultId,
      conversationId,
      kind: "pi.tool-result",
      model: [
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "write",
          content: [],
          isError: options?.resultIsError ?? false,
          timestamp: 1,
        },
      ],
      data: { diagnostics: [] },
      byTaskId: taskId,
    },
  });
  const outcome = options?.outcome ?? "completed";
  entries.push({
    type: "task",
    value: {
      id: taskId,
      conversationId,
      kind: "pi.tool",
      version: 1,
      input: { assistant: 999, callId: "call-1" },
      background: false,
      abortRequested: false,
      state:
        outcome === "completed"
          ? { status: "terminal", outcome: { status: "completed", result: { entryId: resultId } } }
          : { status: "terminal", outcome: { status: "failed", error: { message: "failed" }, result: { entryId: resultId } } },
    },
  });
  await commit(storage, entries);
  return { storage, conversationId, taskId, attemptId, candidateId, resultId, candidate };
}

function verifier() {
  return {
    verify: async (selected: WorkspaceCandidateData) => selected.checkpoint,
  };
}

async function appendPublishedSuccess(
  value: Fixture,
  previous: PublishedWorkspaceRef,
): Promise<{ candidateId: EntryId; candidate: WorkspaceCandidateData }> {
  const taskId = await value.storage.mintId<TaskId<JsonValue>>();
  const attemptId = await value.storage.mintId<EntryId>();
  const candidateId = await value.storage.mintId<EntryId>();
  const resultId = await value.storage.mintId<EntryId>();
  const nextPlan: WorkspaceMutationPlan = {
    ...plan,
    workspace: {
      layerId: "layer-2",
      rootLayerId: plan.workspace.rootLayerId,
      parentLayerId: plan.workspace.layerId,
      parentCheckpointId: value.candidate.checkpoint.checkpointId,
      depth: plan.workspace.depth + 1,
      executionEnvId: "drive9-layer:layer-2",
    },
    previous,
  };
  const attempt = buildWorkspaceAttemptData({
    conversationId: Number(value.conversationId),
    taskId: Number(taskId),
    toolCallId: "call-2",
    effect: "workspace",
    plan: nextPlan,
  });
  const candidate = buildWorkspaceCandidateData({
    attempt,
    attemptId,
    checkpoint: {
      checkpointId: deriveWorkspaceCandidateKey(attempt, attemptId),
      durableSeq: 84,
      layerId: nextPlan.workspace.layerId,
      rootLayerId: nextPlan.workspace.rootLayerId,
      parentLayerId: nextPlan.workspace.parentLayerId,
      parentCheckpointId: nextPlan.workspace.parentCheckpointId,
      depth: nextPlan.workspace.depth,
    },
  });
  await commit(value.storage, [
    {
      type: "entry",
      value: {
        id: attemptId,
        conversationId: value.conversationId,
        kind: WorkspaceAttemptEntry.kind,
        data: attempt,
        byTaskId: taskId,
      },
    },
    {
      type: "entry",
      value: {
        id: candidateId,
        conversationId: value.conversationId,
        kind: WorkspaceCandidateEntry.kind,
        data: candidate,
        byTaskId: taskId,
      },
    },
    {
      type: "entry",
      value: {
        id: resultId,
        conversationId: value.conversationId,
        kind: "pi.tool-result",
        model: [
          {
            role: "toolResult",
            toolCallId: "call-2",
            toolName: "write",
            content: [],
            isError: false,
            timestamp: 2,
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
        conversationId: value.conversationId,
        kind: "pi.tool",
        version: 1,
        input: { assistant: 1000, callId: "call-2" },
        background: false,
        abortRequested: false,
        state: { status: "terminal", outcome: { status: "completed", result: { entryId: resultId } } },
      },
    },
  ]);
  return { candidateId, candidate };
}

test("publishes the newest successful matching candidate", async () => {
  const value = await fixture();
  const published = await resolvePublishedWorkspace({
    storage: value.storage,
    conversationId: value.conversationId,
    verifier: verifier(),
    context: BACKGROUND_CONTEXT,
  });
  assert.equal(published?.candidateEntryId, value.candidateId);
  assert.equal(published?.attemptEntryId, value.attemptId);
  assert.equal(published?.resultEntryId, value.resultId);
  assert.equal(published?.data.candidateKey, value.candidate.candidateKey);
});

test("publishes a candidate only when its previous head matches the verified chain", async () => {
  const value = await fixture();
  const next = await appendPublishedSuccess(value, publishedRef(value.candidate));
  const published = await resolvePublishedWorkspace({
    storage: value.storage,
    conversationId: value.conversationId,
    verifier: verifier(),
    context: BACKGROUND_CONTEXT,
  });
  assert.equal(published?.candidateEntryId, next.candidateId);
  assert.equal(published?.data.candidateKey, next.candidate.candidateKey);
});

test("fails closed when a candidate skips or invents its previous published head", async () => {
  const value = await fixture();
  await appendPublishedSuccess(value, { ...publishedRef(value.candidate), candidateKey: "pic_invalid" });
  await assert.rejects(
    resolvePublishedWorkspace({
      storage: value.storage,
      conversationId: value.conversationId,
      verifier: verifier(),
      context: BACKGROUND_CONTEXT,
    }),
    (error: unknown) => error instanceof Drive9ProtocolError && error.code === "publication_breach",
  );
});

test("does not publish a candidate whose final result is an error", async () => {
  const value = await fixture({ resultIsError: true });
  assert.equal(
    await resolvePublishedWorkspace({
      storage: value.storage,
      conversationId: value.conversationId,
      verifier: verifier(),
      context: BACKGROUND_CONTEXT,
    }),
    undefined,
  );
});

test("does not publish a candidate whose ToolTask failed", async () => {
  const value = await fixture({ outcome: "failed" });
  assert.equal(
    await resolvePublishedWorkspace({
      storage: value.storage,
      conversationId: value.conversationId,
      verifier: verifier(),
      context: BACKGROUND_CONTEXT,
    }),
    undefined,
  );
});

test("a newer orphan candidate cannot replace the last published head", async () => {
  const value = await fixture();
  const orphanTaskId = await value.storage.mintId<TaskId<JsonValue>>();
  const orphanAttemptId = await value.storage.mintId<EntryId>();
  const orphanAttempt = buildWorkspaceAttemptData({
    conversationId: Number(value.conversationId),
    taskId: Number(orphanTaskId),
    toolCallId: "call-orphan",
    effect: "workspace",
    plan,
  });
  const orphanCandidateId = await value.storage.mintId<EntryId>();
  const orphanCheckpoint: VerifiedWorkspaceCheckpoint = {
    ...value.candidate.checkpoint,
    checkpointId: deriveWorkspaceCandidateKey(orphanAttempt, orphanAttemptId),
  };
  const orphanCandidate = buildWorkspaceCandidateData({
    attempt: orphanAttempt,
    attemptId: orphanAttemptId,
    checkpoint: orphanCheckpoint,
  });
  await commit(value.storage, [
    {
      type: "entry",
      value: {
        id: orphanAttemptId,
        conversationId: value.conversationId,
        kind: WorkspaceAttemptEntry.kind,
        data: orphanAttempt,
        byTaskId: orphanTaskId,
      },
    },
    {
      type: "entry",
      value: {
        id: orphanCandidateId,
        conversationId: value.conversationId,
        kind: WorkspaceCandidateEntry.kind,
        data: orphanCandidate,
        byTaskId: orphanTaskId,
      },
    },
  ]);
  const published = await resolvePublishedWorkspace({
    storage: value.storage,
    conversationId: value.conversationId,
    verifier: verifier(),
    context: BACKGROUND_CONTEXT,
  });
  assert.equal(published?.candidateEntryId, value.candidateId);
});

test("coalesces byte-identical duplicate candidates", async () => {
  const value = await fixture({ duplicateCandidate: "identical" });
  const published = await resolvePublishedWorkspace({
    storage: value.storage,
    conversationId: value.conversationId,
    verifier: verifier(),
    context: BACKGROUND_CONTEXT,
  });
  assert.equal(published?.data.candidateKey, value.candidate.candidateKey);
});

test("fails closed when duplicate candidate payloads conflict", async () => {
  const value = await fixture({ duplicateCandidate: "conflict" });
  await assert.rejects(
    resolvePublishedWorkspace({
      storage: value.storage,
      conversationId: value.conversationId,
      verifier: verifier(),
      context: BACKGROUND_CONTEXT,
    }),
    (error: unknown) => error instanceof Drive9ProtocolError && error.code === "candidate_conflict",
  );
});

test("fails closed instead of selecting an older attempt candidate", async () => {
  const value = await fixture();
  const laterAttemptId = await value.storage.mintId<EntryId>();
  const laterAttempt = buildWorkspaceAttemptData({
    conversationId: Number(value.conversationId),
    taskId: Number(value.taskId),
    toolCallId: "call-1",
    effect: "workspace",
    plan,
  });
  const lateResultId = await value.storage.mintId<EntryId>();
  await commit(value.storage, [
    {
      type: "entry",
      value: {
        id: laterAttemptId,
        conversationId: value.conversationId,
        kind: WorkspaceAttemptEntry.kind,
        data: laterAttempt,
        byTaskId: value.taskId,
      },
    },
    {
      type: "entry",
      value: {
        id: lateResultId,
        conversationId: value.conversationId,
        kind: "pi.tool-result",
        model: [
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "write",
            content: [],
            isError: false,
            timestamp: 2,
          },
        ],
        data: { diagnostics: [] },
        byTaskId: value.taskId,
      },
    },
    {
      type: "task",
      value: {
        id: value.taskId,
        conversationId: value.conversationId,
        kind: "pi.tool",
        version: 1,
        input: { assistant: 999, callId: "call-1" },
        background: false,
        abortRequested: false,
        state: { status: "terminal", outcome: { status: "completed", result: { entryId: lateResultId } } },
      },
    },
  ]);
  await assert.rejects(
    resolvePublishedWorkspace({
      storage: value.storage,
      conversationId: value.conversationId,
      verifier: verifier(),
      context: BACKGROUND_CONTEXT,
    }),
    (error: unknown) => error instanceof Drive9ProtocolError && error.code === "publication_breach",
  );
});

test("a fork cutoff before the terminal result does not inherit the candidate", async () => {
  const value = await fixture();
  const childId = await value.storage.mintId<ConversationId>();
  await commit(value.storage, [
    {
      type: "conversation",
      value: {
        id: childId,
        parent: { conversationId: value.conversationId, at: value.candidateId },
      },
    },
  ]);
  const child = await resolvePublishedWorkspace({
    storage: value.storage,
    conversationId: childId,
    verifier: verifier(),
    context: BACKGROUND_CONTEXT,
  });
  assert.equal(child, undefined);
  const parent = await resolvePublishedWorkspace({
    storage: value.storage,
    conversationId: value.conversationId,
    verifier: verifier(),
    context: BACKGROUND_CONTEXT,
  });
  assert.equal(parent?.data.candidateKey, value.candidate.candidateKey);
});

test("fails closed when Drive9 verifies different checkpoint lineage", async () => {
  const value = await fixture();
  await assert.rejects(
    resolvePublishedWorkspace({
      storage: value.storage,
      conversationId: value.conversationId,
      verifier: {
        verify: async (candidate) => ({ ...candidate.checkpoint, durableSeq: candidate.checkpoint.durableSeq + 1 }),
      },
      context: BACKGROUND_CONTEXT,
    }),
    (error: unknown) => error instanceof Drive9ProtocolError && error.code === "checkpoint_mismatch",
  );
});
