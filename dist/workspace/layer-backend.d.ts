import type { Context } from "@earendil-works/chord";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { WorkspaceCoordinatorBackend } from "./coordinator.js";
import type { WorkspaceBinding, WritableWorkspaceHandle } from "./recovery.js";
import type { PublishedWorkspaceRef, VerifiedWorkspaceCheckpoint, WorkspaceCandidateData } from "./types.js";
export type Drive9LayerRecord = {
    readonly layer_id: string;
    readonly state: string;
    readonly durable_seq: number;
    readonly parent_layer_id?: string;
    readonly origin_checkpoint_id?: string;
    readonly root_layer_id?: string;
    readonly depth?: number;
};
export type Drive9LayerCheckpointRecord = {
    readonly checkpoint_id: string;
    readonly layer_id: string;
    readonly durable_seq: number;
};
export type Drive9LayerEventRecord = {
    readonly layer_id: string;
    readonly seq: number;
};
export interface Drive9LayerWorkspaceClient {
    getFSLayer(layerId: string): Promise<Drive9LayerRecord>;
    /**
     * Enumerate every LayerFS layer the caller's scoped credential can see. Used
     * by orphan GC to build a full parent→children reference index: a candidate
     * layer may only be reclaimed when nothing else forks from it, and that set
     * is NOT derivable from the candidate inventory alone (checkpoint-only and
     * other non-candidate layers can still reference it).
     */
    listFSLayers(): Promise<Drive9LayerRecord[]>;
    forkFSLayer(parentRef: string, request?: {
        readonly layer_id?: string;
        readonly name?: string;
        readonly actor_id?: string;
        readonly checkpoint_id?: string;
    }): Promise<Drive9LayerRecord>;
    deleteFSLayer(layerId: string, options?: {
        readonly cascade?: boolean;
    }): Promise<void>;
    checkpointFSLayer(layerId: string, request: {
        readonly checkpoint_id?: string;
        readonly label?: string;
    }): Promise<Drive9LayerCheckpointRecord>;
    getFSLayerCheckpoint(checkpointId: string): Promise<Drive9LayerCheckpointRecord>;
    listFSLayerEvents(layerId: string, since?: number): Promise<Drive9LayerEventRecord[]>;
}
export type StoredWorkspaceBinding = {
    readonly conversationId: ConversationId;
    readonly writerEpoch: string;
    readonly publishedCandidateKey: string | null;
    readonly handle: WritableWorkspaceHandle;
};
export type WorkspaceBindingSwitch = {
    readonly conversationId: ConversationId;
    readonly writerEpoch: string;
    readonly expectedLayerId: string | null;
    readonly publishedCandidateKey: string | null;
    readonly handle: WritableWorkspaceHandle;
};
export type WorkspaceBindingSwitchReceipt = {
    readonly previousLayerId: string | null;
    readonly binding: StoredWorkspaceBinding;
};
export interface Drive9LayerBindingStore {
    readBinding(conversationId: ConversationId, context: Context): Promise<StoredWorkspaceBinding | undefined>;
    compareAndSetBinding(input: WorkspaceBindingSwitch, context: Context): Promise<WorkspaceBindingSwitchReceipt>;
}
export type Drive9LayerWorkspaceBackendOptions = {
    readonly client: Drive9LayerWorkspaceClient;
    readonly bindings: Drive9LayerBindingStore;
};
export declare class Drive9LayerWorkspaceBackend implements WorkspaceCoordinatorBackend {
    #private;
    constructor(options: Drive9LayerWorkspaceBackendOptions);
    currentBinding(conversationId: ConversationId, context: Context): Promise<WorkspaceBinding | undefined>;
    forkFromCheckpoint(input: {
        readonly source: VerifiedWorkspaceCheckpoint;
        readonly childIdentity: string;
        readonly writerEpoch: string;
    }, context: Context): Promise<{
        readonly handle: WritableWorkspaceHandle;
        readonly hasUnpublishedWrites: boolean;
    }>;
    switchBinding(input: WorkspaceBindingSwitch, context: Context): Promise<void>;
    abandon(handle: WritableWorkspaceHandle, context: Context): Promise<void>;
    checkpoint(input: {
        readonly handle: WritableWorkspaceHandle;
        readonly checkpointId: string;
        readonly writerEpoch: string;
        readonly previous: PublishedWorkspaceRef | null;
    }, context: Context): Promise<VerifiedWorkspaceCheckpoint>;
    readCheckpoint(input: {
        readonly checkpointId: string;
        readonly layerId: string;
    }, context: Context): Promise<VerifiedWorkspaceCheckpoint>;
    verify(candidate: WorkspaceCandidateData, context: Context): Promise<VerifiedWorkspaceCheckpoint>;
}
//# sourceMappingURL=layer-backend.d.ts.map