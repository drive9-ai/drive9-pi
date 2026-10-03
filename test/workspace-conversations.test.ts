import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  defineEntry,
  Harness,
  type HarnessOptions,
  MemoryStorage,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { Drive9ProtocolError } from "../src/core/errors.js";
import {
  createDrive9ConversationCreated,
  deriveDrive9WorkspaceId,
  Drive9WorkspaceDoc,
  parseDrive9WorkspaceDocument,
  readDrive9WorkspaceDocument,
} from "../src/workspace/conversations.js";

const MarkerEntry = defineEntry<{ readonly marker: string }>("test.marker");
const context = BACKGROUND_CONTEXT;

function models(): HarnessOptions["models"] {
  return {} as HarnessOptions["models"];
}

test("creates deterministic disjoint workspace identities for root and independent conversations", async () => {
  const storage = new MemoryStorage();
  const harness = await Harness.open(
    storage,
    {
      models: models(),
      registry: createRegistry(),
      conversationCreated: createDrive9ConversationCreated({ sessionId: "session-1" }),
    },
    context,
  );
  try {
    const root = await harness.root(context);
    const independent = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const rootDocument = await readDrive9WorkspaceDocument(harness, root.id, context);
    const independentDocument = await readDrive9WorkspaceDocument(harness, independent.id, context);

    assert.deepEqual(rootDocument, {
      protocolVersion: 1,
      workspaceId: deriveDrive9WorkspaceId("session-1", root.id),
      rootWorkspaceId: deriveDrive9WorkspaceId("session-1", root.id),
      parent: null,
    });
    assert.deepEqual(independentDocument, {
      protocolVersion: 1,
      workspaceId: deriveDrive9WorkspaceId("session-1", independent.id),
      rootWorkspaceId: deriveDrive9WorkspaceId("session-1", independent.id),
      parent: null,
    });
    assert.notEqual(rootDocument.workspaceId, independentDocument.workspaceId);
    assert.match(rootDocument.workspaceId, /^piw_[0-9a-f]{60}$/);
  } finally {
    await harness.close(context);
  }
});

test("records exact immediate transcript lineage while preserving the root workspace identity", async () => {
  const storage = new MemoryStorage();
  const harness = await Harness.open(
    storage,
    {
      models: models(),
      registry: createRegistry(),
      conversationCreated: createDrive9ConversationCreated({ sessionId: "session-2" }),
    },
    context,
  );
  try {
    const root = await harness.root(context);
    const first = await root.commit(
      (tx) => tx.appendEntry(MarkerEntry, root.id, { data: { marker: "root" } }),
      context,
    );
    const child = await root.fork(first.id, { ownership: { kind: "ownerless" } }, context);
    const second = await child.commit(
      (tx) => tx.appendEntry(MarkerEntry, child.id, { data: { marker: "child" } }),
      context,
    );
    const grandchild = await child.fork(second.id, { ownership: { kind: "ownerless" } }, context);

    const rootDocument = await readDrive9WorkspaceDocument(harness, root.id, context);
    const childDocument = await readDrive9WorkspaceDocument(harness, child.id, context);
    const grandchildDocument = await readDrive9WorkspaceDocument(harness, grandchild.id, context);
    assert.deepEqual(childDocument.parent, {
      conversationId: Number(root.id),
      at: Number(first.id),
      workspaceId: rootDocument.workspaceId,
    });
    assert.equal(childDocument.rootWorkspaceId, rootDocument.rootWorkspaceId);
    assert.deepEqual(grandchildDocument.parent, {
      conversationId: Number(child.id),
      at: Number(second.id),
      workspaceId: childDocument.workspaceId,
    });
    assert.equal(grandchildDocument.rootWorkspaceId, rootDocument.rootWorkspaceId);
    assert.notEqual(grandchildDocument.workspaceId, childDocument.workspaceId);
  } finally {
    await harness.close(context);
  }
});

test("fails closed when forking a legacy conversation without Drive9 lineage", async () => {
  const storage = new MemoryStorage();
  const legacyConversationId = await storage.mintId<ConversationId>();
  await storage.commit(
    [{ type: "conversation", value: { id: legacyConversationId } }],
    context,
  );
  const harness = await Harness.open(
    storage,
    {
      models: models(),
      registry: createRegistry(),
      conversationCreated: createDrive9ConversationCreated({ sessionId: "session-3" }),
    },
    context,
  );
  try {
    const legacy = await harness.conversation(legacyConversationId, context);
    assert.notEqual(legacy, undefined);
    const entry = await legacy!.commit(
      (tx) => tx.appendEntry(MarkerEntry, legacyConversationId, { data: { marker: "legacy" } }),
      context,
    );
    await assert.rejects(
      legacy!.fork(entry.id, { ownership: { kind: "ownerless" } }, context),
      (error: unknown) => error instanceof Drive9ProtocolError && error.code === "invalid_protocol_record",
    );
    assert.equal(await harness.snapshot(Drive9WorkspaceDoc, legacyConversationId, context), undefined);
  } finally {
    await harness.close(context);
  }
});

test("rejects publication state in the lineage-only workspace document", () => {
  assert.throws(
    () =>
      parseDrive9WorkspaceDocument({
        protocolVersion: 1,
        workspaceId: "piw_child",
        rootWorkspaceId: "piw_root",
        parent: null,
        reconciled: { checkpointId: "checkpoint-stale", durableSeq: 99 },
      }),
    (error: unknown) => error instanceof Drive9ProtocolError && error.code === "invalid_protocol_record",
  );
});
