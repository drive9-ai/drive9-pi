import type { Context } from "@earendil-works/chord";
import type { ConversationId, EntryId, Storage } from "@earendil-works/pi-durable";
import type { PublishedWorkspaceCandidate, VerifiedWorkspaceCheckpoint, WorkspaceCandidateVerifier, WorkspaceGeneration } from "./types.js";
export type WritableWorkspaceHandle = WorkspaceGeneration & {
    readonly sourceCheckpointId: string;
};
export type WorkspaceBinding = {
    readonly conversationId: ConversationId;
    readonly writerEpoch: string;
    readonly publishedCandidateKey: string | null;
    readonly handle: WritableWorkspaceHandle;
    readonly hasUnpublishedWrites: boolean;
};
export interface WorkspaceRecoveryBackend {
    currentBinding(conversationId: ConversationId, context: Context): Promise<WorkspaceBinding | undefined>;
    forkFromCheckpoint(input: {
        readonly source: VerifiedWorkspaceCheckpoint;
        readonly childIdentity: string;
        readonly writerEpoch: string;
    }, context: Context): Promise<{
        readonly handle: WritableWorkspaceHandle;
        readonly hasUnpublishedWrites: boolean;
    }>;
    switchBinding(input: {
        readonly conversationId: ConversationId;
        readonly writerEpoch: string;
        readonly expectedLayerId: string | null;
        readonly publishedCandidateKey: string | null;
        readonly handle: WritableWorkspaceHandle;
    }, context: Context): Promise<void>;
    abandon(handle: WritableWorkspaceHandle, context: Context): Promise<void>;
}
export type RecoverWorkspaceInput = {
    readonly storage: Storage;
    readonly conversationId: ConversationId;
    readonly expectedSessionId?: string;
    readonly cutoff?: EntryId;
    readonly initialCheckpoint: VerifiedWorkspaceCheckpoint;
    readonly verifier: WorkspaceCandidateVerifier;
    readonly backend: WorkspaceRecoveryBackend;
    readonly context: Context;
    readonly maxLayerDepth: number;
    readonly mode: WorkspaceRecoveryMode;
    readonly onAbandonError?: (error: Error) => void;
};
export type WorkspaceRecoveryMode = {
    readonly kind: "stable";
} | {
    readonly kind: "single-coordinator-preview";
    readonly writerEpoch: string;
};
export type RecoveredWorkspace = {
    readonly published: PublishedWorkspaceCandidate | undefined;
    readonly binding: WorkspaceBinding;
};
export declare function recoverWorkspace(input: RecoverWorkspaceInput): Promise<RecoveredWorkspace>;
//# sourceMappingURL=recovery.d.ts.map