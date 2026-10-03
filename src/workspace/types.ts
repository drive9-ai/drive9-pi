import type { Context } from "@earendil-works/chord";
import type { ConversationId, EntryId, TaskId, ToolExecutionApi } from "@earendil-works/pi-durable";

export const DRIVE9_WORKSPACE_PROTOCOL_VERSION = 1 as const;
export const DRIVE9_WORKSPACE_BARRIER_PROTOCOL = "drive9.workspace-barrier/v1" as const;

export type Drive9Effect = "none" | "workspace" | "external" | "workspace+external";
export type Drive9WorkspaceEffect = Extract<Drive9Effect, "workspace" | "workspace+external">;

export type WorkspaceGeneration = {
  readonly layerId: string;
  readonly rootLayerId: string;
  readonly parentLayerId: string | null;
  readonly parentCheckpointId: string | null;
  readonly depth: number;
  readonly executionEnvId: string;
};

export type PublishedWorkspaceRef = {
  readonly candidateKey: string;
  readonly checkpointId: string;
  readonly durableSeq: number;
  readonly layerId: string;
  readonly rootLayerId: string;
  readonly depth: number;
};

export type WorkspaceAttemptData = {
  readonly protocolVersion: typeof DRIVE9_WORKSPACE_PROTOCOL_VERSION;
  readonly sessionId: string;
  readonly conversationId: number;
  readonly taskId: number;
  readonly toolCallId: string;
  readonly writerEpoch: string;
  readonly effect: Drive9WorkspaceEffect;
  readonly workspace: WorkspaceGeneration;
  readonly previous: PublishedWorkspaceRef | null;
};

export type VerifiedWorkspaceCheckpoint = {
  readonly checkpointId: string;
  readonly durableSeq: number;
  readonly layerId: string;
  readonly rootLayerId: string;
  readonly parentLayerId: string | null;
  readonly parentCheckpointId: string | null;
  readonly depth: number;
};

export type WorkspaceCandidateData = WorkspaceAttemptData & {
  readonly attemptId: number;
  readonly candidateKey: string;
  readonly barrierProtocol: typeof DRIVE9_WORKSPACE_BARRIER_PROTOCOL;
  readonly checkpoint: VerifiedWorkspaceCheckpoint;
  readonly integrityDigest: string;
};

export type WorkspaceMutationPlan = {
  readonly sessionId: string;
  readonly writerEpoch: string;
  readonly workspace: WorkspaceGeneration;
  readonly previous: PublishedWorkspaceRef | null;
};

export type WorkspaceCheckpointRequest = {
  readonly checkpointId: string;
  readonly attemptId: EntryId;
  readonly conversationId: ConversationId;
  readonly taskId: TaskId;
  readonly toolCallId: string;
  readonly effect: Drive9WorkspaceEffect;
  readonly plan: WorkspaceMutationPlan;
};

export interface WorkspaceMutationCoordinator {
  prepare(
    input: {
      readonly conversationId: ConversationId;
      readonly taskId: TaskId;
      readonly toolCallId: string;
      readonly effect: Drive9WorkspaceEffect;
      readonly env: ToolExecutionApi["env"];
    },
    context: Context,
  ): Promise<WorkspaceMutationPlan>;
  checkpointAndVerify(request: WorkspaceCheckpointRequest, context: Context): Promise<VerifiedWorkspaceCheckpoint>;
  invalidate(plan: WorkspaceMutationPlan): void;
  poison(error: Error, context: Context): Promise<never>;
}

export interface WorkspaceCandidateVerifier {
  verify(candidate: WorkspaceCandidateData, context: Context): Promise<VerifiedWorkspaceCheckpoint>;
}

export type PublishedWorkspaceCandidate = {
  readonly attemptEntryId: EntryId;
  readonly candidateEntryId: EntryId;
  readonly resultEntryId: EntryId;
  readonly taskId: TaskId;
  readonly data: WorkspaceCandidateData;
};
