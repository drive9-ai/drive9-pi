import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  ConversationId,
  EntryId,
  EntryRecord,
  TaskId,
  ToolExecutionApi,
  ToolRegistration,
  Tx,
} from "@earendil-works/pi-durable";
import { Drive9ProtocolError } from "../src/core/errors.js";
import { WorkspaceAttemptEntry, WorkspaceCandidateEntry } from "../src/workspace/entries.js";
import type { WorkspaceMutationCoordinator, WorkspaceMutationPlan } from "../src/workspace/types.js";
import { withDrive9Effects } from "../src/workspace/wrap-tool.js";

const plan: WorkspaceMutationPlan = {
  sessionId: "session-1",
  writerEpoch: "epoch-1",
  workspace: {
    layerId: "layer-1",
    rootLayerId: "root-1",
    parentLayerId: null,
    parentCheckpointId: null,
    depth: 1,
    executionEnvId: "drive9-layer:layer-1",
  },
  previous: null,
};

function tool(result: { isError?: boolean } = {}, executeError?: Error): ToolRegistration {
  return {
    name: "write",
    label: "write",
    description: "write",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      if (executeError !== undefined) throw executeError;
      return { content: [], ...result };
    },
  } as unknown as ToolRegistration;
}

function harness(options?: { failCandidateCommit?: boolean; result?: { isError?: boolean }; executeError?: Error }) {
  const entries: EntryRecord[] = [];
  let nextEntryId = 10;
  let commits = 0;
  let checkpoints = 0;
  let invalidations = 0;
  let poisoned: Drive9ProtocolError | undefined;
  const taskId = 2 as TaskId;
  const conversationId = 1 as ConversationId;
  const tx = {
    appendEntry: async (...args: unknown[]) => {
      const token = args[0] as { kind: string };
      const value = args[2] as { data: unknown };
      const entry = {
        id: nextEntryId++ as EntryId,
        conversationId,
        kind: token.kind,
        data: value.data,
        byTaskId: taskId,
      } as EntryRecord;
      entries.push(entry);
      return entry;
    },
  } as unknown as Tx;
  const api = {
    taskId,
    conversationId,
    callId: "call-1",
    env: undefined,
    commit: async <T>(change: (transaction: Tx) => T | Promise<T>) => {
      commits += 1;
      if (options?.failCandidateCommit === true && commits === 2) throw new Error("commit response lost");
      return await change(tx);
    },
  } as unknown as ToolExecutionApi;
  const coordinator: WorkspaceMutationCoordinator = {
    prepare: async () => plan,
    checkpointAndVerify: async (request) => {
      checkpoints += 1;
      return {
        checkpointId: request.checkpointId,
        durableSeq: 9,
        layerId: plan.workspace.layerId,
        rootLayerId: plan.workspace.rootLayerId,
        parentLayerId: plan.workspace.parentLayerId,
        parentCheckpointId: plan.workspace.parentCheckpointId,
        depth: plan.workspace.depth,
      };
    },
    invalidate: () => {
      invalidations += 1;
    },
    poison: async (error) => {
      poisoned = error as Drive9ProtocolError;
      throw error;
    },
  };
  return {
    api,
    coordinator,
    entries,
    get checkpoints() {
      return checkpoints;
    },
    get invalidations() {
      return invalidations;
    },
    get poisoned() {
      return poisoned;
    },
    wrapped: withDrive9Effects(tool(options?.result, options?.executeError), { coordinator, effect: "workspace" }),
  };
}

test("wraps a successful workspace tool with attempt then candidate entries", async () => {
  const value = harness();
  const result = await value.wrapped.execute({}, value.api, BACKGROUND_CONTEXT);
  assert.equal(result.isError, undefined);
  assert.equal(value.wrapped.executionMode, "sequential");
  assert.equal(value.wrapped.replay, "safe");
  assert.equal(value.checkpoints, 1);
  assert.deepEqual(
    value.entries.map((entry) => entry.kind),
    [WorkspaceAttemptEntry.kind, WorkspaceCandidateEntry.kind],
  );
  assert.equal(
    (value.entries[1]!.data as { attemptId: number }).attemptId,
    Number(value.entries[0]!.id),
  );
});

test("an error result leaves only an attempt and invalidates the generation", async () => {
  const value = harness({ result: { isError: true } });
  const result = await value.wrapped.execute({}, value.api, BACKGROUND_CONTEXT);
  assert.equal(result.isError, true);
  assert.equal(value.checkpoints, 0);
  assert.equal(value.invalidations, 1);
  assert.deepEqual(value.entries.map((entry) => entry.kind), [WorkspaceAttemptEntry.kind]);
});

test("a thrown tool error invalidates the generation without creating a candidate", async () => {
  const executeError = new Error("tool crashed");
  const value = harness({ executeError });
  await assert.rejects(value.wrapped.execute({}, value.api, BACKGROUND_CONTEXT), executeError);
  assert.equal(value.checkpoints, 0);
  assert.equal(value.invalidations, 1);
  assert.deepEqual(value.entries.map((entry) => entry.kind), [WorkspaceAttemptEntry.kind]);
});

test("an unknown candidate commit outcome poisons the current session", async () => {
  const value = harness({ failCandidateCommit: true });
  await assert.rejects(
    value.wrapped.execute({}, value.api, BACKGROUND_CONTEXT),
    (error: unknown) => error instanceof Drive9ProtocolError && error.code === "candidate_commit_unknown",
  );
  assert.equal(value.invalidations, 1);
  assert.equal(value.poisoned?.code, "candidate_commit_unknown");
});

test("unknown environment-capable tools default to sequential replay-unsafe wrapping", () => {
  const value = harness();
  const wrapped = withDrive9Effects({ ...tool(), name: "third_party" }, { coordinator: value.coordinator });
  assert.equal(wrapped.executionMode, "sequential");
  assert.equal(wrapped.replay, "unsafe");
});
