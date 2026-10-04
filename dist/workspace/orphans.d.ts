import type { Context } from "@earendil-works/chord";
import { type ConversationId, type EntryId, type Storage } from "@earendil-works/pi-durable";
import type { WorkspaceCandidateVerifier } from "./types.js";
export type WorkspaceCandidateDisposition = {
    readonly kind: "published";
    readonly reason: "published-chain";
} | {
    readonly kind: "permanently-unpublishable";
    readonly reason: "task-terminal-failed" | "task-terminal-aborted" | "task-terminal-orphaned" | "task-terminal-faulted" | "tool-result-error" | "terminal-success-not-selected";
} | {
    readonly kind: "unresolved";
    readonly reason: "session-mismatch" | "candidate-entry-mismatch" | "attempt-not-visible" | "attempt-mismatch" | "task-missing" | "task-kind-mismatch" | "task-active" | "task-completing" | "terminal-result-invalid" | "terminal-result-not-visible" | "terminal-result-mismatch";
};
export type WorkspaceCandidateInventoryItem = {
    readonly candidateKey: string;
    readonly checkpointId: string;
    readonly durableSeq: number;
    readonly layerId: string;
    readonly rootLayerId: string;
    readonly sessionId: string;
    readonly sourceConversationId: number;
    readonly taskId: number;
    readonly toolCallId: string;
    readonly attemptId: number;
    readonly candidateEntryIds: readonly EntryId[];
    readonly disposition: WorkspaceCandidateDisposition;
};
export type WorkspaceCandidateInventory = {
    readonly conversationId: ConversationId;
    readonly cutoff?: EntryId;
    readonly publishedCandidateKey: string | null;
    readonly candidateRecordCount: number;
    readonly uniqueCandidateCount: number;
    readonly publishedCount: number;
    readonly permanentlyUnpublishableCount: number;
    readonly unresolvedCount: number;
    readonly requiresAttention: boolean;
    readonly items: readonly WorkspaceCandidateInventoryItem[];
};
export type InspectWorkspaceCandidateInventoryInput = {
    readonly storage: Storage;
    readonly conversationId: ConversationId;
    readonly cutoff?: EntryId;
    readonly expectedSessionId?: string;
    readonly verifier: WorkspaceCandidateVerifier;
    readonly context: Context;
};
export type ReportWorkspaceCandidateInventoryInput = InspectWorkspaceCandidateInventoryInput & {
    readonly report: (inventory: WorkspaceCandidateInventory, context: Context) => void | Promise<void>;
    readonly onReportError?: (error: Error) => void | Promise<void>;
};
export declare function inspectWorkspaceCandidateInventory(input: InspectWorkspaceCandidateInventoryInput): Promise<WorkspaceCandidateInventory>;
export declare function reportWorkspaceCandidateInventory(input: ReportWorkspaceCandidateInventoryInput): Promise<WorkspaceCandidateInventory>;
//# sourceMappingURL=orphans.d.ts.map