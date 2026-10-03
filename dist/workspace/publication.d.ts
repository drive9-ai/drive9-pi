import type { Context } from "@earendil-works/chord";
import { type ConversationId, type EntryId, type Storage } from "@earendil-works/pi-durable";
import type { PublishedWorkspaceCandidate, WorkspaceCandidateVerifier } from "./types.js";
export declare function resolvePublishedWorkspace(input: {
    readonly storage: Storage;
    readonly conversationId: ConversationId;
    readonly cutoff?: EntryId;
    readonly verifier: WorkspaceCandidateVerifier;
    readonly context: Context;
}): Promise<PublishedWorkspaceCandidate | undefined>;
//# sourceMappingURL=publication.d.ts.map