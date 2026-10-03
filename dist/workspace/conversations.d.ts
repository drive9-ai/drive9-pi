import type { Context } from "@earendil-works/chord";
import { type ConversationId, type DocumentReader, type HarnessOptions } from "@earendil-works/pi-durable";
export declare const DRIVE9_WORKSPACE_DOCUMENT_VERSION: 1;
export type Drive9WorkspaceParent = {
    readonly conversationId: number;
    readonly at: number;
    readonly workspaceId: string;
};
export type Drive9WorkspaceDocument = {
    protocolVersion: typeof DRIVE9_WORKSPACE_DOCUMENT_VERSION;
    workspaceId: string;
    rootWorkspaceId: string;
    parent: Drive9WorkspaceParent | null;
};
export declare const Drive9WorkspaceDoc: import("@earendil-works/pi-durable").RewindableConversationDocToken<Drive9WorkspaceDocument>;
export type Drive9ConversationCreatedOptions = {
    readonly sessionId: string;
};
type Drive9ConversationCreated = NonNullable<HarnessOptions["conversationCreated"]>;
export declare function parseDrive9WorkspaceDocument(value: unknown): Drive9WorkspaceDocument;
export declare function deriveDrive9WorkspaceId(sessionId: string, conversationId: ConversationId | number): string;
export declare function createDrive9ConversationCreated(options: Drive9ConversationCreatedOptions): Drive9ConversationCreated;
export declare function readDrive9WorkspaceDocument(read: DocumentReader, conversationId: ConversationId, context: Context): Promise<Drive9WorkspaceDocument>;
export {};
//# sourceMappingURL=conversations.d.ts.map