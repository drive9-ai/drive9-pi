import assert from "node:assert/strict";
import test from "node:test";
import { Drive9ProtocolError } from "../src/core/errors.js";
import {
  buildWorkspaceAttemptData,
  buildWorkspaceCandidateData,
  deriveWorkspaceCandidateKey,
  parseWorkspaceCandidateData,
} from "../src/workspace/entries.js";
import type { WorkspaceMutationPlan } from "../src/workspace/types.js";

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

function attempt() {
  return buildWorkspaceAttemptData({
    conversationId: 7,
    taskId: 9,
    toolCallId: "call-1",
    effect: "workspace",
    plan,
  });
}

test("derives a deterministic checkpoint-safe candidate identity", () => {
  const value = attempt();
  const first = deriveWorkspaceCandidateKey(value, 11);
  const second = deriveWorkspaceCandidateKey(value, 11);
  assert.equal(first, second);
  assert.match(first, /^pic_[0-9a-f]{60}$/);
  assert.equal(Buffer.byteLength(first, "utf8"), 64);
});

test("binds candidate identity to the physical workspace generation", () => {
  const firstGeneration = attempt();
  const nextPlan: WorkspaceMutationPlan = {
    ...plan,
    workspace: {
      layerId: "layer-2",
      rootLayerId: plan.workspace.rootLayerId,
      parentLayerId: plan.workspace.layerId,
      parentCheckpointId: "checkpoint-1",
      depth: plan.workspace.depth + 1,
      executionEnvId: "drive9-layer:layer-2",
    },
  };
  const nextGeneration = buildWorkspaceAttemptData({
    conversationId: firstGeneration.conversationId,
    taskId: firstGeneration.taskId,
    toolCallId: firstGeneration.toolCallId,
    effect: firstGeneration.effect,
    plan: nextPlan,
  });

  assert.notEqual(
    deriveWorkspaceCandidateKey(firstGeneration, 11),
    deriveWorkspaceCandidateKey(nextGeneration, 11),
  );
});

test("round-trips an integrity-bound candidate", () => {
  const value = attempt();
  const checkpointId = deriveWorkspaceCandidateKey(value, 11);
  const candidate = buildWorkspaceCandidateData({
    attempt: value,
    attemptId: 11,
    checkpoint: {
      checkpointId,
      durableSeq: 42,
      layerId: plan.workspace.layerId,
      rootLayerId: plan.workspace.rootLayerId,
      parentLayerId: plan.workspace.parentLayerId,
      parentCheckpointId: plan.workspace.parentCheckpointId,
      depth: plan.workspace.depth,
    },
  });
  assert.deepEqual(parseWorkspaceCandidateData(candidate), candidate);
  assert.throws(
    () => parseWorkspaceCandidateData({ ...candidate, writerEpoch: "epoch-forged" }),
    (error: unknown) => error instanceof Drive9ProtocolError && error.code === "invalid_protocol_record",
  );
});

test("rejects a checkpoint from a different physical generation", () => {
  const value = attempt();
  assert.throws(
    () =>
      buildWorkspaceCandidateData({
        attempt: value,
        attemptId: 11,
        checkpoint: {
          checkpointId: deriveWorkspaceCandidateKey(value, 11),
          durableSeq: 42,
          layerId: "layer-other",
          rootLayerId: plan.workspace.rootLayerId,
          parentLayerId: plan.workspace.parentLayerId,
          parentCheckpointId: plan.workspace.parentCheckpointId,
          depth: plan.workspace.depth,
        },
      }),
    (error: unknown) => error instanceof Drive9ProtocolError && error.code === "invalid_protocol_record",
  );
});

test("rejects workspace generations beyond the LayerFS hard limit", () => {
  assert.throws(
    () =>
      buildWorkspaceAttemptData({
        conversationId: 7,
        taskId: 9,
        toolCallId: "call-1",
        effect: "workspace",
        plan: { ...plan, workspace: { ...plan.workspace, depth: 17 } },
      }),
    (error: unknown) => error instanceof Drive9ProtocolError && error.code === "invalid_protocol_record",
  );
});
