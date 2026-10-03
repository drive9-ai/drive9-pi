import { defineDoc, } from "@earendil-works/pi-durable";
import { Drive9ProtocolError } from "../core/errors.js";
import { prefixedDigest } from "../core/identity.js";
export const DRIVE9_WORKSPACE_DOCUMENT_VERSION = 1;
export const Drive9WorkspaceDoc = defineDoc({
    kind: "drive9.workspace",
    version: DRIVE9_WORKSPACE_DOCUMENT_VERSION,
    scope: "conversation",
    history: "rewindable",
    fork: "asOf",
    initial: () => ({
        protocolVersion: DRIVE9_WORKSPACE_DOCUMENT_VERSION,
        workspaceId: "",
        rootWorkspaceId: "",
        parent: null,
    }),
});
const DOCUMENT_KEYS = new Set(["protocolVersion", "workspaceId", "rootWorkspaceId", "parent"]);
const PARENT_KEYS = new Set(["conversationId", "at", "workspaceId"]);
function rejectUnknownKeys(input, allowed, label) {
    const unknown = Object.keys(input).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
        throw new Drive9ProtocolError("invalid_protocol_record", `${label} has unknown fields: ${unknown.join(", ")}`);
    }
}
function requiredString(value, label) {
    if (typeof value !== "string" || value.length === 0) {
        throw new Drive9ProtocolError("invalid_protocol_record", `${label} must be a non-empty string`);
    }
    return value;
}
function positiveInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Drive9ProtocolError("invalid_protocol_record", `${label} must be a positive safe integer`);
    }
    return value;
}
export function parseDrive9WorkspaceDocument(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Drive9ProtocolError("invalid_protocol_record", "workspace document must be an object");
    }
    const input = value;
    rejectUnknownKeys(input, DOCUMENT_KEYS, "workspace document");
    if (input.protocolVersion !== DRIVE9_WORKSPACE_DOCUMENT_VERSION) {
        throw new Drive9ProtocolError("invalid_protocol_record", "workspace document protocol version is unsupported");
    }
    let parent;
    if (input.parent === null) {
        parent = null;
    }
    else {
        if (typeof input.parent !== "object" || input.parent === null || Array.isArray(input.parent)) {
            throw new Drive9ProtocolError("invalid_protocol_record", "workspace parent must be an object or null");
        }
        const parentInput = input.parent;
        rejectUnknownKeys(parentInput, PARENT_KEYS, "workspace parent");
        parent = {
            conversationId: positiveInteger(parentInput.conversationId, "workspace parent conversation ID"),
            at: positiveInteger(parentInput.at, "workspace parent cutoff"),
            workspaceId: requiredString(parentInput.workspaceId, "workspace parent ID"),
        };
    }
    return {
        protocolVersion: DRIVE9_WORKSPACE_DOCUMENT_VERSION,
        workspaceId: requiredString(input.workspaceId, "workspace ID"),
        rootWorkspaceId: requiredString(input.rootWorkspaceId, "root workspace ID"),
        parent,
    };
}
export function deriveDrive9WorkspaceId(sessionId, conversationId) {
    const session = requiredString(sessionId, "session ID");
    const conversation = positiveInteger(Number(conversationId), "conversation ID");
    return prefixedDigest("piw_", {
        protocol: "drive9.workspace-identity/v1",
        sessionId: session,
        conversationId: conversation,
    });
}
function applyConversationIdentity(document, conversation, sessionId) {
    const workspaceId = deriveDrive9WorkspaceId(sessionId, conversation.id);
    if (conversation.parent === undefined) {
        document.protocolVersion = DRIVE9_WORKSPACE_DOCUMENT_VERSION;
        document.workspaceId = workspaceId;
        document.rootWorkspaceId = workspaceId;
        document.parent = null;
        return;
    }
    const inherited = parseDrive9WorkspaceDocument(document);
    document.protocolVersion = DRIVE9_WORKSPACE_DOCUMENT_VERSION;
    document.workspaceId = workspaceId;
    document.rootWorkspaceId = inherited.rootWorkspaceId;
    document.parent = {
        conversationId: Number(conversation.parent.conversationId),
        at: Number(conversation.parent.at),
        workspaceId: inherited.workspaceId,
    };
}
export function createDrive9ConversationCreated(options) {
    requiredString(options.sessionId, "session ID");
    return async (tx, conversation) => {
        const document = await tx.doc(Drive9WorkspaceDoc, conversation.id);
        applyConversationIdentity(document, conversation, options.sessionId);
    };
}
export async function readDrive9WorkspaceDocument(read, conversationId, context) {
    const document = await read.snapshot(Drive9WorkspaceDoc, conversationId, context);
    if (document === undefined) {
        throw new Drive9ProtocolError("invalid_protocol_record", "conversation has no Drive9 workspace document");
    }
    return parseDrive9WorkspaceDocument(document);
}
//# sourceMappingURL=conversations.js.map