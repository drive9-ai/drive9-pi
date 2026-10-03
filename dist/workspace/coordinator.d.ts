import type { Context } from "@earendil-works/chord";
import type { ConversationId, Storage } from "@earendil-works/pi-durable";
import { Drive9ProtocolError } from "../core/errors.js";
import { type WorkspaceRecoveryBackend, type WorkspaceRecoveryMode, type WritableWorkspaceHandle } from "./recovery.js";
import type { PublishedWorkspaceRef, VerifiedWorkspaceCheckpoint, WorkspaceCandidateVerifier, WorkspaceCheckpointRequest, WorkspaceMutationCoordinator, WorkspaceMutationPlan } from "./types.js";
export interface WorkspaceCoordinatorBackend extends WorkspaceRecoveryBackend, WorkspaceCandidateVerifier {
    /** Returns only after every included write is durably recoverable from another process. */
    checkpoint(input: {
        readonly handle: WritableWorkspaceHandle;
        readonly checkpointId: string;
        readonly writerEpoch: string;
        readonly previous: PublishedWorkspaceRef | null;
    }, context: Context): Promise<VerifiedWorkspaceCheckpoint>;
    /** Independently reads the persisted checkpoint instead of trusting the create response. */
    readCheckpoint(input: {
        readonly checkpointId: string;
        readonly layerId: string;
    }, context: Context): Promise<VerifiedWorkspaceCheckpoint>;
}
export type Drive9WorkspaceCoordinatorOptions = {
    readonly sessionId: string;
    readonly storage: Storage;
    readonly backend: WorkspaceCoordinatorBackend;
    readonly initialCheckpoint: (conversationId: ConversationId, context: Context) => Promise<VerifiedWorkspaceCheckpoint>;
    readonly maxLayerDepth: number;
    readonly mode: WorkspaceRecoveryMode;
    readonly onAbandonError?: (error: Error) => void;
    readonly onPoison?: (error: Drive9ProtocolError, context: Context) => void | Promise<void>;
};
export declare class Drive9WorkspaceCoordinator implements WorkspaceMutationCoordinator {
    #private;
    constructor(options: Drive9WorkspaceCoordinatorOptions);
    prepare(input: Parameters<WorkspaceMutationCoordinator["prepare"]>[0], context: Context): Promise<WorkspaceMutationPlan>;
    checkpointAndVerify(request: WorkspaceCheckpointRequest, context: Context): Promise<VerifiedWorkspaceCheckpoint>;
    invalidate(plan: WorkspaceMutationPlan): void;
    poison(error: Error, context: Context): Promise<never>;
}
export declare function createDrive9WorkspaceCoordinator(options: Drive9WorkspaceCoordinatorOptions): WorkspaceMutationCoordinator;
//# sourceMappingURL=coordinator.d.ts.map