import type { Context } from "@earendil-works/chord";
import {
  defineDoc,
  type ConversationId,
  type ConversationRecord,
  type DocumentReader,
  type HarnessOptions,
} from "@earendil-works/pi-durable";
import { Drive9ProtocolError } from "../core/errors.js";
import { prefixedDigest } from "../core/identity.js";

export const DRIVE9_WORKSPACE_DOCUMENT_VERSION = 1 as const;

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

export const Drive9WorkspaceDoc = defineDoc<Drive9WorkspaceDocument>({
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

export type Drive9ConversationCreatedOptions = {
  readonly sessionId: string;
};

type Drive9ConversationCreated = NonNullable<HarnessOptions["conversationCreated"]>;

const DOCUMENT_KEYS = new Set(["protocolVersion", "workspaceId", "rootWorkspaceId", "parent"]);
const PARENT_KEYS = new Set(["conversationId", "at", "workspaceId"]);

function rejectUnknownKeys(input: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Drive9ProtocolError("invalid_protocol_record", `${label} has unknown fields: ${unknown.join(", ")}`);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Drive9ProtocolError("invalid_protocol_record", `${label} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Drive9ProtocolError("invalid_protocol_record", `${label} must be a positive safe integer`);
  }
  return value as number;
}

export function parseDrive9WorkspaceDocument(value: unknown): Drive9WorkspaceDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Drive9ProtocolError("invalid_protocol_record", "workspace document must be an object");
  }
  const input = value as Record<string, unknown>;
  rejectUnknownKeys(input, DOCUMENT_KEYS, "workspace document");
  if (input.protocolVersion !== DRIVE9_WORKSPACE_DOCUMENT_VERSION) {
    throw new Drive9ProtocolError("invalid_protocol_record", "workspace document protocol version is unsupported");
  }
  let parent: Drive9WorkspaceParent | null;
  if (input.parent === null) {
    parent = null;
  } else {
    if (typeof input.parent !== "object" || input.parent === null || Array.isArray(input.parent)) {
      throw new Drive9ProtocolError("invalid_protocol_record", "workspace parent must be an object or null");
    }
    const parentInput = input.parent as Record<string, unknown>;
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

export function deriveDrive9WorkspaceId(sessionId: string, conversationId: ConversationId | number): string {
  const session = requiredString(sessionId, "session ID");
  const conversation = positiveInteger(Number(conversationId), "conversation ID");
  return prefixedDigest("piw_", {
    protocol: "drive9.workspace-identity/v1",
    sessionId: session,
    conversationId: conversation,
  });
}

function applyConversationIdentity(
  document: Drive9WorkspaceDocument,
  conversation: ConversationRecord,
  sessionId: string,
): void {
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

export function createDrive9ConversationCreated(
  options: Drive9ConversationCreatedOptions,
): Drive9ConversationCreated {
  requiredString(options.sessionId, "session ID");
  return async (tx, conversation) => {
    const document = await tx.doc(Drive9WorkspaceDoc, conversation.id);
    applyConversationIdentity(document, conversation, options.sessionId);
  };
}

export async function readDrive9WorkspaceDocument(
  read: DocumentReader,
  conversationId: ConversationId,
  context: Context,
): Promise<Drive9WorkspaceDocument> {
  const document = await read.snapshot(Drive9WorkspaceDoc, conversationId, context);
  if (document === undefined) {
    throw new Drive9ProtocolError("invalid_protocol_record", "conversation has no Drive9 workspace document");
  }
  return parseDrive9WorkspaceDocument(document);
}
