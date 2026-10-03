import type { JsonValue } from "@earendil-works/chord";
import { defineEntry, type EntryId } from "@earendil-works/pi-durable";
import { Drive9ProtocolError } from "../core/errors.js";
import { prefixedDigest, sha256Hex } from "../core/identity.js";
import {
  DRIVE9_WORKSPACE_BARRIER_PROTOCOL,
  DRIVE9_WORKSPACE_PROTOCOL_VERSION,
  type Drive9WorkspaceEffect,
  type PublishedWorkspaceRef,
  type VerifiedWorkspaceCheckpoint,
  type WorkspaceAttemptData,
  type WorkspaceCandidateData,
  type WorkspaceGeneration,
  type WorkspaceMutationPlan,
} from "./types.js";

export const WorkspaceAttemptEntry = defineEntry<WorkspaceAttemptData>("drive9.workspace-attempt");
export const WorkspaceCandidateEntry = defineEntry<WorkspaceCandidateData>("drive9.workspace-candidate");

type RecordValue = Record<string, unknown>;

function invalid(message: string): never {
  throw new Drive9ProtocolError("invalid_protocol_record", message);
}

function record(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as RecordValue;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) invalid(`${label} must be a non-empty string`);
  return value as string;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    invalid(`${label} must be a safe integer greater than or equal to ${minimum}`);
  }
  return value as number;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : stringValue(value, label);
}

function workspaceEffect(value: unknown): Drive9WorkspaceEffect {
  if (value !== "workspace" && value !== "workspace+external") {
    invalid("effect must describe a workspace mutation");
  }
  return value;
}

function parseGeneration(value: unknown, label: string): WorkspaceGeneration {
  const input = record(value, label);
  const depth = integer(input.depth, `${label}.depth`);
  if (depth > 16) invalid(`${label}.depth exceeds the LayerFS hard limit`);
  return {
    layerId: stringValue(input.layerId, `${label}.layerId`),
    rootLayerId: stringValue(input.rootLayerId, `${label}.rootLayerId`),
    parentLayerId: nullableString(input.parentLayerId, `${label}.parentLayerId`),
    parentCheckpointId: nullableString(input.parentCheckpointId, `${label}.parentCheckpointId`),
    depth,
    executionEnvId: stringValue(input.executionEnvId, `${label}.executionEnvId`),
  };
}

function parsePrevious(value: unknown): PublishedWorkspaceRef | null {
  if (value === null) return null;
  const input = record(value, "previous");
  return {
    candidateKey: stringValue(input.candidateKey, "previous.candidateKey"),
    checkpointId: stringValue(input.checkpointId, "previous.checkpointId"),
    durableSeq: integer(input.durableSeq, "previous.durableSeq"),
    layerId: stringValue(input.layerId, "previous.layerId"),
    rootLayerId: stringValue(input.rootLayerId, "previous.rootLayerId"),
    depth: integer(input.depth, "previous.depth"),
  };
}

function parseCheckpoint(value: unknown): VerifiedWorkspaceCheckpoint {
  const input = record(value, "checkpoint");
  return {
    checkpointId: stringValue(input.checkpointId, "checkpoint.checkpointId"),
    durableSeq: integer(input.durableSeq, "checkpoint.durableSeq"),
    layerId: stringValue(input.layerId, "checkpoint.layerId"),
    rootLayerId: stringValue(input.rootLayerId, "checkpoint.rootLayerId"),
    parentLayerId: nullableString(input.parentLayerId, "checkpoint.parentLayerId"),
    parentCheckpointId: nullableString(input.parentCheckpointId, "checkpoint.parentCheckpointId"),
    depth: integer(input.depth, "checkpoint.depth"),
  };
}

export function parseWorkspaceAttemptData(value: unknown): WorkspaceAttemptData {
  const input = record(value, "workspace attempt");
  if (input.protocolVersion !== DRIVE9_WORKSPACE_PROTOCOL_VERSION) {
    invalid("workspace attempt protocol version is unsupported");
  }
  return {
    protocolVersion: DRIVE9_WORKSPACE_PROTOCOL_VERSION,
    sessionId: stringValue(input.sessionId, "sessionId"),
    conversationId: integer(input.conversationId, "conversationId", 1),
    taskId: integer(input.taskId, "taskId", 1),
    toolCallId: stringValue(input.toolCallId, "toolCallId"),
    writerEpoch: stringValue(input.writerEpoch, "writerEpoch"),
    effect: workspaceEffect(input.effect),
    workspace: parseGeneration(input.workspace, "workspace"),
    previous: parsePrevious(input.previous),
  };
}

export function buildWorkspaceAttemptData(input: {
  readonly conversationId: number;
  readonly taskId: number;
  readonly toolCallId: string;
  readonly effect: Drive9WorkspaceEffect;
  readonly plan: WorkspaceMutationPlan;
}): WorkspaceAttemptData {
  return parseWorkspaceAttemptData({
    protocolVersion: DRIVE9_WORKSPACE_PROTOCOL_VERSION,
    sessionId: input.plan.sessionId,
    conversationId: input.conversationId,
    taskId: input.taskId,
    toolCallId: input.toolCallId,
    writerEpoch: input.plan.writerEpoch,
    effect: input.effect,
    workspace: input.plan.workspace,
    previous: input.plan.previous,
  });
}

function candidateIdentity(attempt: WorkspaceAttemptData, attemptId: number): JsonValue {
  return {
    protocolVersion: DRIVE9_WORKSPACE_PROTOCOL_VERSION,
    barrierProtocol: DRIVE9_WORKSPACE_BARRIER_PROTOCOL,
    attemptId,
    sessionId: attempt.sessionId,
    conversationId: attempt.conversationId,
    taskId: attempt.taskId,
    toolCallId: attempt.toolCallId,
    writerEpoch: attempt.writerEpoch,
    effect: attempt.effect,
    workspace: attempt.workspace,
    previous: attempt.previous,
  };
}

export function deriveWorkspaceCandidateKey(attempt: WorkspaceAttemptData, attemptId: EntryId | number): string {
  return prefixedDigest("pic_", candidateIdentity(parseWorkspaceAttemptData(attempt), Number(attemptId)));
}

export function buildWorkspaceCandidateData(input: {
  readonly attempt: WorkspaceAttemptData;
  readonly attemptId: EntryId | number;
  readonly checkpoint: VerifiedWorkspaceCheckpoint;
}): WorkspaceCandidateData {
  const attempt = parseWorkspaceAttemptData(input.attempt);
  const attemptId = integer(Number(input.attemptId), "attemptId", 1);
  const candidateKey = deriveWorkspaceCandidateKey(attempt, attemptId);
  const checkpoint = parseCheckpoint(input.checkpoint);
  if (checkpoint.checkpointId !== candidateKey) invalid("checkpoint ID does not match the candidate identity");
  if (
    checkpoint.layerId !== attempt.workspace.layerId ||
    checkpoint.rootLayerId !== attempt.workspace.rootLayerId ||
    checkpoint.parentLayerId !== attempt.workspace.parentLayerId ||
    checkpoint.parentCheckpointId !== attempt.workspace.parentCheckpointId ||
    checkpoint.depth !== attempt.workspace.depth
  ) {
    invalid("checkpoint lineage does not match the attempted workspace generation");
  }
  const withoutDigest = {
    ...attempt,
    attemptId,
    candidateKey,
    barrierProtocol: DRIVE9_WORKSPACE_BARRIER_PROTOCOL,
    checkpoint,
  } as const;
  return {
    ...withoutDigest,
    integrityDigest: sha256Hex(withoutDigest as JsonValue),
  };
}

export function parseWorkspaceCandidateData(value: unknown): WorkspaceCandidateData {
  const input = record(value, "workspace candidate");
  const attempt = parseWorkspaceAttemptData(input);
  const attemptId = integer(input.attemptId, "attemptId", 1);
  const candidateKey = stringValue(input.candidateKey, "candidateKey");
  if (!/^pic_[0-9a-f]{60}$/.test(candidateKey)) invalid("candidateKey is not a Drive9 candidate digest");
  if (input.barrierProtocol !== DRIVE9_WORKSPACE_BARRIER_PROTOCOL) {
    invalid("workspace barrier protocol is unsupported");
  }
  const checkpoint = parseCheckpoint(input.checkpoint);
  const integrityDigest = stringValue(input.integrityDigest, "integrityDigest");
  const expected = buildWorkspaceCandidateData({ attempt, attemptId, checkpoint });
  if (candidateKey !== expected.candidateKey) invalid("candidateKey does not match the candidate identity");
  if (integrityDigest !== expected.integrityDigest) invalid("candidate integrity digest does not match its payload");
  return expected;
}
