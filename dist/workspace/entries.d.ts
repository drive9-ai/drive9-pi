import { type EntryId } from "@earendil-works/pi-durable";
import { type Drive9WorkspaceEffect, type VerifiedWorkspaceCheckpoint, type WorkspaceAttemptData, type WorkspaceCandidateData, type WorkspaceMutationPlan } from "./types.js";
export declare const WorkspaceAttemptEntry: import("@earendil-works/pi-durable").Entry<WorkspaceAttemptData>;
export declare const WorkspaceCandidateEntry: import("@earendil-works/pi-durable").Entry<WorkspaceCandidateData>;
export declare function parseWorkspaceAttemptData(value: unknown): WorkspaceAttemptData;
export declare function buildWorkspaceAttemptData(input: {
    readonly conversationId: number;
    readonly taskId: number;
    readonly toolCallId: string;
    readonly effect: Drive9WorkspaceEffect;
    readonly plan: WorkspaceMutationPlan;
}): WorkspaceAttemptData;
export declare function deriveWorkspaceCandidateKey(attempt: WorkspaceAttemptData, attemptId: EntryId | number): string;
export declare function buildWorkspaceCandidateData(input: {
    readonly attempt: WorkspaceAttemptData;
    readonly attemptId: EntryId | number;
    readonly checkpoint: VerifiedWorkspaceCheckpoint;
}): WorkspaceCandidateData;
export declare function parseWorkspaceCandidateData(value: unknown): WorkspaceCandidateData;
//# sourceMappingURL=entries.d.ts.map