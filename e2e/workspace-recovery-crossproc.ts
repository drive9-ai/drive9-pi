/**
 * REAL-backend, cross-process restore-by-fork recovery E2E for drive9-pi.
 *
 * This script exercises the actual {@link recoverWorkspace} pipeline against the
 * real {@link Drive9LayerWorkspaceBackend}, which forks a fresh LayerFS
 * generation from the PUBLISHED checkpoint on the live Drive9 server
 * (`~/.drive9/config` -> `Client.defaultClient()`).
 *
 * It proves four things that a broken implementation would fail:
 *
 *   1. TRUE cross-process read. The parent process publishes + checkpoints +
 *      runs recovery. A SECOND, freshly spawned Node process (`npx tsx <self>`
 *      with DRIVE9_E2E_ROLE=child) constructs its OWN independent
 *      `Client.defaultClient()` (its own TCP connection + auth) and reads the
 *      exact bytes of the recovered layer and the published checkpoint. The
 *      child exits non-zero on any mismatch; the parent asserts child exit 0.
 *      A same-handle "second reader" (re-using the parent's in-memory client)
 *      cannot satisfy this, because the reader is a different OS process that
 *      shares nothing but the server state.
 *
 *   2. Fork-from-PUBLISHED, not latest-physical, not in-place. We deliberately
 *      create a LATER orphan/unpublished checkpoint whose bytes DIFFER from the
 *      parent head. Recovery must still fork from the published checkpoint, so
 *      the recovered + cross-process-read bytes equal the PUBLISHED content and
 *      NOT the orphan content, the recovered layer is a NEW generation
 *      (different layerId), and it carries no inherited writes (0 events).
 *
 *   3. Conversation fork cutoff. The parent publishes A, forks a Pi child, then
 *      publishes B. Parent recovery must fork from B while child recovery must
 *      fork from A. Independent processes verify both exact byte sets and exact
 *      checkpoint lineage. Reading the parent's latest head for the child fails.
 *
 *   4. Fail-closed on a publication breach. A published candidate whose root
 *      lineage does not match the recovery's initialCheckpoint is rejected with
 *      Drive9ProtocolError("publication_breach") before any workspace mutation.
 *
 * This closes the real workspace-backend durability/fork gate only. Pi Storage
 * remains in-memory and recovery runs in explicit single-coordinator preview
 * mode; this does not prove server-enforced writer-epoch fencing.
 *
 * Teardown: every FSLayer this test creates has a deterministic identity, is
 * cascade-abandoned in a finally path, and is verified non-active before the
 * script reports PASS. If the server is unreachable the script prints SKIP by
 * default; set DRIVE9_E2E_REQUIRED=1 to make that condition fail the run.
 *
 * Run: `npm run e2e:recovery-crossproc`
 * Gate: `DRIVE9_E2E_REQUIRED=1 npm run e2e:recovery-crossproc`
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  MemoryStorage,
  type ConversationId,
  type EntryId,
  type StorageWrite,
  type TaskId,
} from "@earendil-works/pi-durable";
import { Client } from "drive9";
import { Drive9ProtocolError } from "../src/core/errors.js";
import {
  WorkspaceAttemptEntry,
  WorkspaceCandidateEntry,
  buildWorkspaceAttemptData,
  buildWorkspaceCandidateData,
  deriveWorkspaceCandidateKey,
} from "../src/workspace/entries.js";
import {
  Drive9LayerWorkspaceBackend,
  type Drive9LayerBindingStore,
  type Drive9LayerWorkspaceClient,
  type StoredWorkspaceBinding,
  type WorkspaceBindingSwitch,
  type WorkspaceBindingSwitchReceipt,
} from "../src/workspace/layer-backend.js";
import { recoverWorkspace } from "../src/workspace/recovery.js";
import type {
  PublishedWorkspaceRef,
  VerifiedWorkspaceCheckpoint,
  WorkspaceMutationPlan,
} from "../src/workspace/types.js";

const LAYER_PREFIX = "dev1-e2e-";
const FILE_NAME = "state.txt";
const PUBLISHED_CONTENT = "dev1-e2e PUBLISHED workspace bytes\n";
const PARENT_LATER_CONTENT = "dev1-e2e PARENT later bytes (child must NOT inherit)\n";
const ORPHAN_CONTENT = "dev1-e2e ORPHAN unpublished bytes (must NOT be recovered)\n";

// ---------------------------------------------------------------------------
// Exact pinned SDK capability gate.
//
// The package's public dependency remains drive9@0.1.4 until the prepared 0.2.0
// release is published. Repository E2E uses scripts/install-pinned-drive9-sdk.sh
// to overlay the exact reviewed SDK commit that exposes forkFSLayer/deleteFSLayer.
// No raw HTTP fallback is allowed: this test must exercise the production SDK
// methods that Drive9LayerWorkspaceBackend will receive.
// ---------------------------------------------------------------------------
const REQUIRED_LAYER_METHODS = [
  "getFSLayer",
  "listFSLayers",
  "forkFSLayer",
  "deleteFSLayer",
  "checkpointFSLayer",
  "getFSLayerCheckpoint",
  "listFSLayerEvents",
] as const;

function requiredLayerClient(client: Client): Drive9LayerWorkspaceClient {
  const methods = client as unknown as Record<string, unknown>;
  const missing = REQUIRED_LAYER_METHODS.filter((method) => typeof methods[method] !== "function");
  if (missing.length > 0) {
    throw new Error(
      `Drive9 SDK is missing ${missing.join(", ")}; run bash scripts/install-pinned-drive9-sdk.sh`,
    );
  }
  return client as unknown as Drive9LayerWorkspaceClient;
}

type MutationCounter = { forks: number; checkpoints: number; deletes: number };

// Wraps a Drive9LayerWorkspaceClient and counts the mutating verbs so the
// breach path can assert ZERO backend mutation (no fork/checkpoint/delete).
function countingLayerClient(
  inner: Drive9LayerWorkspaceClient,
  counter: MutationCounter,
): Drive9LayerWorkspaceClient {
  return {
    getFSLayer: (layerId) => inner.getFSLayer(layerId),
    listFSLayers: () => inner.listFSLayers(),
    forkFSLayer: (parentRef, request) => {
      counter.forks += 1;
      return inner.forkFSLayer(parentRef, request);
    },
    deleteFSLayer: (layerId, options) => {
      counter.deletes += 1;
      return inner.deleteFSLayer(layerId, options);
    },
    checkpointFSLayer: (layerId, request) => {
      counter.checkpoints += 1;
      return inner.checkpointFSLayer(layerId, request);
    },
    getFSLayerCheckpoint: (checkpointId) => inner.getFSLayerCheckpoint(checkpointId),
    listFSLayerEvents: (layerId, since) => inner.listFSLayerEvents(layerId, since),
  };
}

// ---------------------------------------------------------------------------
// In-memory single-coordinator binding store. The recovery binding is the
// local writer-fencing record; it is not a server resource, so an in-memory
// compare-and-set faithfully models the single-coordinator-preview mode used
// by the existing recovery tests. Pure test scaffolding.
// ---------------------------------------------------------------------------
class InMemoryBindings implements Drive9LayerBindingStore {
  #current: StoredWorkspaceBinding | undefined;

  async readBinding(): Promise<StoredWorkspaceBinding | undefined> {
    return this.#current;
  }

  async compareAndSetBinding(input: WorkspaceBindingSwitch): Promise<WorkspaceBindingSwitchReceipt> {
    const previousLayerId = this.#current?.handle.layerId ?? null;
    if (previousLayerId !== input.expectedLayerId) {
      const error = new Error("binding compare-and-set expected layer mismatch") as Error & {
        statusCode?: number;
      };
      error.statusCode = 409;
      throw error;
    }
    const binding: StoredWorkspaceBinding = {
      conversationId: input.conversationId,
      writerEpoch: input.writerEpoch,
      publishedCandidateKey: input.publishedCandidateKey,
      handle: input.handle,
    };
    this.#current = binding;
    return { previousLayerId, binding };
  }
}

// ---------------------------------------------------------------------------
// Live-server scaffolding.
// ---------------------------------------------------------------------------
type Tracked = {
  readonly client: Client;
  readonly layerClient: Drive9LayerWorkspaceClient;
  readonly created: Set<string>;
  readonly basePaths: Set<string>;
};

function trackedClient(): Tracked {
  const client = Client.defaultClient();
  return {
    client,
    layerClient: requiredLayerClient(client),
    created: new Set(),
    basePaths: new Set(),
  };
}

async function withRetry<T>(label: string, attempts: number, run: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${String(lastError)}`);
}

async function probeAvailable(tracked: Tracked): Promise<boolean> {
  try {
    await withRetry("backend probe", 3, async () => {
      await tracked.client.warm();
      await tracked.client.listFSLayers();
    });
    return true;
  } catch {
    return false;
  }
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as { readonly statusCode?: unknown }).statusCode;
  return typeof value === "number" ? value : undefined;
}

async function deleteLayer(tracked: Tracked, layerId: string, cascade: boolean): Promise<void> {
  try {
    await withRetry(`deleteFSLayer ${layerId}`, 3, () =>
      tracked.layerClient.deleteFSLayer(layerId, { cascade }),
    );
  } catch (error) {
    if (statusCode(error) !== 404) throw error;
  }
}

function filePath(base: string): string {
  return `${base}/${FILE_NAME}`;
}

// Build the real server + Pi history:
//   R   (root, depth 0)              -- checkpoint cpR
//   P1  = fork(R @ cpR)              -- parent publishes A
//   C   = Pi conversation fork at P1's terminal result
//   P2  = fork(P1 @ cp1)             -- parent later publishes B
//   O   = fork(P2 @ cp2)             -- later orphan, never published
//
// Parent recovery must select P2. Child recovery must select P1 through Pi's
// ancestry/cutoff visibility, even though P2 and O physically exist later.
type Publication = {
  readonly layerId: string;
  readonly checkpoint: VerifiedWorkspaceCheckpoint;
  readonly candidateKey: string;
  readonly resultEntryId: EntryId;
};

type Published = {
  readonly storage: MemoryStorage;
  readonly conversationId: ConversationId;
  readonly childConversationId: ConversationId;
  readonly writerEpoch: string;
  readonly rootLayerId: string;
  readonly rootCheckpointId: string;
  readonly forkPoint: Publication;
  readonly parentLatest: Publication;
  readonly initialCheckpoint: VerifiedWorkspaceCheckpoint;
  readonly sessionId: string;
  readonly basePath: string;
};

function publicationRef(value: Publication): PublishedWorkspaceRef {
  return {
    candidateKey: value.candidateKey,
    checkpointId: value.checkpoint.checkpointId,
    durableSeq: value.checkpoint.durableSeq,
    layerId: value.checkpoint.layerId,
    rootLayerId: value.checkpoint.rootLayerId,
    depth: value.checkpoint.depth,
  };
}

async function appendPublishedWorkspace(
  tracked: Tracked,
  input: {
    readonly storage: MemoryStorage;
    readonly conversationId: ConversationId;
    readonly sessionId: string;
    readonly writerEpoch: string;
    readonly basePath: string;
    readonly source: VerifiedWorkspaceCheckpoint;
    readonly previous: PublishedWorkspaceRef | null;
    readonly label: string;
    readonly content: string;
  },
): Promise<Publication> {
  const layerId = `${LAYER_PREFIX}${input.label}-${randomUUID().slice(0, 12).replace(/-/g, "")}`;
  tracked.created.add(layerId);
  const layer = await withRetry(`forkFSLayer ${input.source.layerId}`, 3, () =>
    tracked.layerClient.forkFSLayer(input.source.layerId, {
      layer_id: layerId,
      name: `${LAYER_PREFIX}${input.label}`,
      checkpoint_id: input.source.checkpointId,
    }),
  );
  assert.equal(layer.layer_id, layerId, `${input.label} layer identity`);
  assert.equal(layer.parent_layer_id, input.source.layerId, `${input.label} parent layer`);
  assert.equal(layer.origin_checkpoint_id, input.source.checkpointId, `${input.label} parent checkpoint`);
  assert.equal(layer.root_layer_id, input.source.rootLayerId, `${input.label} root lineage`);
  assert.equal(layer.depth, input.source.depth + 1, `${input.label} depth`);
  await tracked.client.uploadFSLayerFile(layer.layer_id, filePath(input.basePath), Buffer.from(input.content));

  const taskId = await input.storage.mintId<TaskId<JsonValue>>();
  const attemptId = await input.storage.mintId<EntryId>();
  const candidateId = await input.storage.mintId<EntryId>();
  const resultId = await input.storage.mintId<EntryId>();
  const toolCallId = `call-${input.label}`;
  const plan: WorkspaceMutationPlan = {
    sessionId: input.sessionId,
    writerEpoch: input.writerEpoch,
    workspace: {
      layerId: layer.layer_id,
      rootLayerId: input.source.rootLayerId,
      parentLayerId: input.source.layerId,
      parentCheckpointId: input.source.checkpointId,
      depth: input.source.depth + 1,
      executionEnvId: `drive9-layer:${layer.layer_id}`,
    },
    previous: input.previous,
  };
  const attempt = buildWorkspaceAttemptData({
    conversationId: Number(input.conversationId),
    taskId: Number(taskId),
    toolCallId,
    effect: "workspace",
    plan,
  });
  const checkpointId = deriveWorkspaceCandidateKey(attempt, attemptId);
  const checkpointRecord = await tracked.layerClient.checkpointFSLayer(layer.layer_id, {
    checkpoint_id: checkpointId,
    label: `${LAYER_PREFIX}${input.label}`,
  });
  const verified: VerifiedWorkspaceCheckpoint = {
    checkpointId,
    durableSeq: checkpointRecord.durable_seq,
    layerId: layer.layer_id,
    rootLayerId: input.source.rootLayerId,
    parentLayerId: input.source.layerId,
    parentCheckpointId: input.source.checkpointId,
    depth: input.source.depth + 1,
  };
  const candidate = buildWorkspaceCandidateData({ attempt, attemptId, checkpoint: verified });
  const writes: StorageWrite[] = [
    {
      type: "entry",
      value: {
        id: attemptId,
        conversationId: input.conversationId,
        kind: WorkspaceAttemptEntry.kind,
        data: attempt,
        byTaskId: taskId,
      },
    },
    {
      type: "entry",
      value: {
        id: candidateId,
        conversationId: input.conversationId,
        kind: WorkspaceCandidateEntry.kind,
        data: candidate,
        byTaskId: taskId,
      },
    },
    {
      type: "entry",
      value: {
        id: resultId,
        conversationId: input.conversationId,
        kind: "pi.tool-result",
        model: [
          {
            role: "toolResult",
            toolCallId,
            toolName: "write",
            content: [],
            isError: false,
            timestamp: 1,
          },
        ],
        data: { diagnostics: [] },
        byTaskId: taskId,
      },
    },
    {
      type: "task",
      value: {
        id: taskId,
        conversationId: input.conversationId,
        kind: "pi.tool",
        version: 1,
        input: { assistant: 1, callId: toolCallId },
        background: false,
        abortRequested: false,
        state: { status: "terminal", outcome: { status: "completed", result: { entryId: resultId } } },
      },
    },
  ];
  await input.storage.commit(writes, BACKGROUND_CONTEXT);
  return {
    layerId: layer.layer_id,
    checkpoint: verified,
    candidateKey: candidate.candidateKey,
    resultEntryId: resultId,
  };
}

async function seedPublishedWorkspace(tracked: Tracked): Promise<Published> {
  const client = tracked.client;
  const stamp = Date.now();
  const basePath = `/${LAYER_PREFIX}root-${stamp}-${randomUUID().slice(0, 8)}`;
  tracked.basePaths.add(basePath);
  const sessionId = `${LAYER_PREFIX}session-${randomUUID()}`;
  const writerEpoch = `${LAYER_PREFIX}epoch-${randomUUID()}`;

  // Root layer R + its checkpoint cpR.
  const rootLayerId = `${LAYER_PREFIX}root-${randomUUID().slice(0, 12).replace(/-/g, "")}`;
  tracked.created.add(rootLayerId);
  const root = await withRetry("createFSLayer(root)", 3, () =>
    client.createFSLayer({
      layer_id: rootLayerId,
      base_root_path: basePath,
      name: `${LAYER_PREFIX}root`,
    }),
  );
  assert.equal(root.layer_id, rootLayerId, "root layer identity");
  const rootCheckpointId = `dev1e2ecpr${stamp}${randomUUID().slice(0, 8).replace(/-/g, "")}`;
  const rootCheckpoint = await client.checkpointFSLayer(root.layer_id, {
    checkpoint_id: rootCheckpointId,
    label: `${LAYER_PREFIX}root`,
  });
  const storage = new MemoryStorage();
  const conversationId = await storage.mintId<ConversationId>();
  await storage.commit([{ type: "conversation", value: { id: conversationId } }], BACKGROUND_CONTEXT);
  const initialCheckpoint: VerifiedWorkspaceCheckpoint = {
    checkpointId: rootCheckpointId,
    durableSeq: rootCheckpoint.durable_seq,
    layerId: root.layer_id,
    rootLayerId: root.layer_id,
    parentLayerId: null,
    parentCheckpointId: null,
    depth: 0,
  };
  const forkPoint = await appendPublishedWorkspace(tracked, {
    storage,
    conversationId,
    sessionId,
    writerEpoch,
    basePath,
    source: initialCheckpoint,
    previous: null,
    label: "fork-point",
    content: PUBLISHED_CONTENT,
  });

  const childConversationId = await storage.mintId<ConversationId>();
  await storage.commit(
    [
      {
        type: "conversation",
        value: {
          id: childConversationId,
          parent: { conversationId, at: forkPoint.resultEntryId },
        },
      },
    ],
    BACKGROUND_CONTEXT,
  );

  const parentLatest = await appendPublishedWorkspace(tracked, {
    storage,
    conversationId,
    sessionId,
    writerEpoch,
    basePath,
    source: forkPoint.checkpoint,
    previous: publicationRef(forkPoint),
    label: "parent-later",
    content: PARENT_LATER_CONTENT,
  });

  // O is a later physical checkpoint with different bytes and no Pi record.
  const orphanLayerId = `${LAYER_PREFIX}orphan-${randomUUID().slice(0, 12).replace(/-/g, "")}`;
  tracked.created.add(orphanLayerId);
  const orphan = await withRetry(`forkFSLayer ${parentLatest.layerId}`, 3, () =>
    tracked.layerClient.forkFSLayer(parentLatest.layerId, {
      layer_id: orphanLayerId,
      name: `${LAYER_PREFIX}orphan`,
      checkpoint_id: parentLatest.checkpoint.checkpointId,
    }),
  );
  assert.equal(orphan.layer_id, orphanLayerId, "orphan layer identity");
  await client.uploadFSLayerFile(orphan.layer_id, filePath(basePath), Buffer.from(ORPHAN_CONTENT));
  const orphanCheckpointId = `dev1e2ecpo${stamp}${randomUUID().slice(0, 8).replace(/-/g, "")}`;
  await client.checkpointFSLayer(orphan.layer_id, {
    checkpoint_id: orphanCheckpointId,
    label: `${LAYER_PREFIX}orphan`,
  });

  return {
    storage,
    conversationId,
    childConversationId,
    writerEpoch,
    rootLayerId: root.layer_id,
    rootCheckpointId,
    forkPoint,
    parentLatest,
    initialCheckpoint,
    sessionId,
    basePath,
  };
}

async function cascadeAbandonAll(tracked: Tracked): Promise<void> {
  const failures: Error[] = [];
  try {
    for (const layer of await tracked.client.listFSLayers()) {
      if (tracked.basePaths.has(layer.base_root_path)) tracked.created.add(layer.layer_id);
    }
  } catch (error) {
    failures.push(new Error("cleanup discovery failed", { cause: error }));
  }
  for (const layerId of [...tracked.created].reverse()) {
    try {
      await deleteLayer(tracked, layerId, true);
    } catch (error) {
      failures.push(new Error(`cleanup failed for ${layerId}`, { cause: error }));
    }
  }
  try {
    const active = (await tracked.client.listFSLayers()).filter(
      (layer) =>
        (tracked.created.has(layer.layer_id) || tracked.basePaths.has(layer.base_root_path)) &&
        layer.state !== "abandoned",
    );
    if (active.length > 0) {
      failures.push(
        new Error(
          `cleanup left active layers: ${active.map((layer) => `${layer.layer_id}:${layer.state}`).join(", ")}`,
        ),
      );
    }
  } catch (error) {
    failures.push(new Error("cleanup verification failed", { cause: error }));
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "real-backend E2E cleanup failed");
  }
}

// ---------------------------------------------------------------------------
// Child process: a genuinely separate OS process with its OWN Client.
// Reads the recovered layer + published checkpoint by identity and fails
// closed on any mismatch. Receives its expectations via DRIVE9_E2E_PAYLOAD.
// ---------------------------------------------------------------------------
type ChildPayload = {
  readonly label: string;
  readonly recoveredLayerId: string;
  readonly sourceLayerId: string;
  readonly sourceCheckpointId: string;
  readonly basePath: string;
  readonly expectedHex: string;
  readonly forbiddenHex: readonly string[];
  readonly expectedDurableSeq: number;
  readonly expectedDepth: number;
  readonly expectedRootLayerId: string;
};

async function runChildReader(): Promise<void> {
  const payload = JSON.parse(process.env.DRIVE9_E2E_PAYLOAD ?? "{}") as ChildPayload;
  const client = Client.defaultClient(); // independent process, independent connection
  const layerClient = requiredLayerClient(client);
  await withRetry("child.warm", 3, async () => {
    await client.warm();
  });

  // (a) Read the recovered layer's bytes from a fresh process.
  const recoveredBytes = Buffer.from(
    await withRetry("child.read", 3, () => client.readFSLayerFile(payload.recoveredLayerId, filePath(payload.basePath))),
  );
  const expected = Buffer.from(payload.expectedHex, "hex");

  assert.ok(expected.equals(recoveredBytes), `${payload.label} bytes must equal its published checkpoint`);
  for (const forbiddenHex of payload.forbiddenHex) {
    assert.ok(
      !Buffer.from(forbiddenHex, "hex").equals(recoveredBytes),
      `${payload.label} bytes must not equal a later or orphan workspace`,
    );
  }

  // (b) Independently resolve the published checkpoint identity + lineage.
  const checkpoint = await withRetry("child.getCheckpoint", 3, () =>
    layerClient.getFSLayerCheckpoint(payload.sourceCheckpointId),
  );
  assert.equal(checkpoint.checkpoint_id, payload.sourceCheckpointId, "checkpoint identity");
  assert.equal(checkpoint.layer_id, payload.sourceLayerId, "checkpoint belongs to the published layer");
  assert.equal(checkpoint.durable_seq, payload.expectedDurableSeq, "checkpoint durable sequence");

  // (c) Independently confirm the recovered layer is a fresh fork of P@cpP.
  const recovered = await withRetry("child.getLayer", 3, () => layerClient.getFSLayer(payload.recoveredLayerId));
  assert.notEqual(recovered.layer_id, payload.sourceLayerId, "recovered layer is a NEW generation");
  assert.equal(recovered.parent_layer_id, payload.sourceLayerId, "recovered parent is the published layer");
  assert.equal(
    recovered.origin_checkpoint_id,
    payload.sourceCheckpointId,
    "recovered layer forked from the published checkpoint",
  );
  assert.equal(recovered.root_layer_id, payload.expectedRootLayerId, "recovered root lineage");
  assert.equal(recovered.depth, payload.expectedDepth, "recovered depth = published depth + 1");
  const recoveredEvents = await withRetry("child.listEvents", 3, () =>
    layerClient.listFSLayerEvents(payload.recoveredLayerId, 0),
  );
  assert.equal(recoveredEvents.length, 0, "recovered generation starts without unpublished events");

  process.stdout.write(`CHILD-OK: ${payload.label} matches its published checkpoint exactly\n`);
}

function spawnChildReader(payload: ChildPayload): number {
  // Spawn a genuinely separate OS process running THIS file under the tsx
  // loader (so `.ts` + `.js`-mapped imports resolve exactly as in the parent).
  // The child gets no handles from this process -- only env -- and builds its
  // own Client.defaultClient(), so it cannot share the parent's connection.
  const self = fileURLToPath(import.meta.url);
  const result = spawnSync(process.execPath, ["--import", "tsx", self], {
    env: {
      ...process.env,
      DRIVE9_E2E_ROLE: "child",
      DRIVE9_E2E_PAYLOAD: JSON.stringify(payload),
    },
    stdio: "inherit",
    encoding: "utf8",
  });
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}

// ---------------------------------------------------------------------------
// Parent (orchestrator).
// ---------------------------------------------------------------------------
async function assertPublicationBreachFailsClosed(tracked: Tracked, published: Published): Promise<void> {
  const counter: MutationCounter = { forks: 0, checkpoints: 0, deletes: 0 };
  const backend = new Drive9LayerWorkspaceBackend({
    client: countingLayerClient(tracked.layerClient, counter),
    bindings: new InMemoryBindings(),
  });
  // initialCheckpoint from a DIFFERENT root lineage: resolvePublishedWorkspace
  // finds the real published candidate, then recoverWorkspace rejects it
  // because its rootLayerId does not match this initialCheckpoint's root.
  const foreignRoot: VerifiedWorkspaceCheckpoint = {
    checkpointId: `${LAYER_PREFIX}foreign-root`,
    durableSeq: 0,
    layerId: `${LAYER_PREFIX}foreign-root-layer`,
    rootLayerId: `${LAYER_PREFIX}foreign-root-layer`,
    parentLayerId: null,
    parentCheckpointId: null,
    depth: 0,
  };
  let fired = false;
  try {
    await recoverWorkspace({
      storage: published.storage,
      conversationId: published.conversationId,
      expectedSessionId: published.sessionId,
      initialCheckpoint: foreignRoot,
      verifier: backend,
      backend,
      context: BACKGROUND_CONTEXT,
      maxLayerDepth: 16,
      mode: { kind: "single-coordinator-preview", writerEpoch: published.writerEpoch },
    });
  } catch (error) {
    fired =
      error instanceof Drive9ProtocolError && error.code === "publication_breach";
    if (!fired) throw error;
  }
  assert.ok(fired, "recovery must fail closed with publication_breach on a foreign root lineage");
  // Zero backend mutation: the breach is detected before any fork/checkpoint/
  // delete, so no new layer is created or abandoned on the server.
  assert.equal(counter.forks, 0, "publication breach must not fork a backend layer");
  assert.equal(counter.checkpoints, 0, "publication breach must not checkpoint a backend layer");
  assert.equal(counter.deletes, 0, "publication breach must not abandon a backend layer");
  process.stdout.write(
    "ASSERT 4 OK: foreign-root recovery fails closed (publication_breach) with ZERO backend mutation\n",
  );
}

async function runParent(): Promise<void> {
  const tracked = trackedClient();

  if (!(await probeAvailable(tracked))) {
    if (process.env.DRIVE9_E2E_REQUIRED === "1") {
      throw new Error("real Drive9 backend unavailable while DRIVE9_E2E_REQUIRED=1");
    }
    process.stdout.write("SKIP: authenticated real Drive9 backend unavailable\n");
    return;
  }

  let runError: unknown;
  try {
    const published = await seedPublishedWorkspace(tracked);

    const parentBackend = new Drive9LayerWorkspaceBackend({
      client: tracked.layerClient,
      bindings: new InMemoryBindings(),
    });
    const parentRecovered = await recoverWorkspace({
      storage: published.storage,
      conversationId: published.conversationId,
      expectedSessionId: published.sessionId,
      initialCheckpoint: published.initialCheckpoint,
      verifier: parentBackend,
      backend: parentBackend,
      context: BACKGROUND_CONTEXT,
      maxLayerDepth: 16,
      mode: { kind: "single-coordinator-preview", writerEpoch: published.writerEpoch },
    });
    const parentRecoveredLayerId = parentRecovered.binding.handle.layerId;
    tracked.created.add(parentRecoveredLayerId);

    // ASSERT 2: parent recovery selected its newest PUBLISHED checkpoint and
    // forked a NEW generation from it (not latest-physical, not in-place).
    assert.equal(
      parentRecovered.published?.data.checkpoint.checkpointId,
      published.parentLatest.checkpoint.checkpointId,
      "parent recovery resolved its latest published checkpoint",
    );
    assert.equal(
      parentRecovered.binding.handle.parentCheckpointId,
      published.parentLatest.checkpoint.checkpointId,
      "parent generation forked from its published checkpoint",
    );
    assert.equal(
      parentRecovered.binding.handle.parentLayerId,
      published.parentLatest.layerId,
      "parent generation source is the published layer",
    );
    assert.notEqual(
      parentRecoveredLayerId,
      published.parentLatest.layerId,
      "parent recovery creates a NEW layer, not in-place",
    );
    assert.equal(
      parentRecovered.binding.hasUnpublishedWrites,
      false,
      "parent recovery has no inherited writes",
    );
    assert.equal(
      parentRecovered.binding.handle.depth,
      published.parentLatest.checkpoint.depth + 1,
      "parent recovery depth = published + 1",
    );
    process.stdout.write("ASSERT 2 OK: parent recovery forked from its latest published checkpoint\n");

    // ASSERT 1: TRUE cross-process read of the parent head, not the orphan.
    const parentPayload: ChildPayload = {
      label: "parent",
      recoveredLayerId: parentRecoveredLayerId,
      sourceLayerId: published.parentLatest.layerId,
      sourceCheckpointId: published.parentLatest.checkpoint.checkpointId,
      basePath: published.basePath,
      expectedHex: Buffer.from(PARENT_LATER_CONTENT).toString("hex"),
      forbiddenHex: [
        Buffer.from(PUBLISHED_CONTENT).toString("hex"),
        Buffer.from(ORPHAN_CONTENT).toString("hex"),
      ],
      expectedDurableSeq: published.parentLatest.checkpoint.durableSeq,
      expectedDepth: published.parentLatest.checkpoint.depth + 1,
      expectedRootLayerId: published.rootLayerId,
    };
    assert.equal(
      spawnChildReader(parentPayload),
      0,
      "fresh process must read the parent published bytes by identity",
    );
    process.stdout.write("ASSERT 1 OK: independent process read the recovered parent publication\n");

    // ASSERT 3: child recovery is pinned to the Pi fork cutoff. The parent has
    // already published different bytes after that cutoff.
    const childBackend = new Drive9LayerWorkspaceBackend({
      client: tracked.layerClient,
      bindings: new InMemoryBindings(),
    });
    const childRecovered = await recoverWorkspace({
      storage: published.storage,
      conversationId: published.childConversationId,
      expectedSessionId: published.sessionId,
      initialCheckpoint: published.initialCheckpoint,
      verifier: childBackend,
      backend: childBackend,
      context: BACKGROUND_CONTEXT,
      maxLayerDepth: 16,
      mode: { kind: "single-coordinator-preview", writerEpoch: `${published.writerEpoch}-child` },
    });
    const childRecoveredLayerId = childRecovered.binding.handle.layerId;
    tracked.created.add(childRecoveredLayerId);
    assert.equal(
      childRecovered.published?.data.checkpoint.checkpointId,
      published.forkPoint.checkpoint.checkpointId,
      "child resolves the publication visible at its exact transcript cutoff",
    );
    assert.equal(
      childRecovered.binding.handle.parentLayerId,
      published.forkPoint.layerId,
      "child forks from the cutoff-visible parent layer",
    );
    assert.equal(
      childRecovered.binding.handle.parentCheckpointId,
      published.forkPoint.checkpoint.checkpointId,
      "child forks from the cutoff-visible checkpoint",
    );
    assert.notEqual(
      childRecovered.binding.handle.parentCheckpointId,
      published.parentLatest.checkpoint.checkpointId,
      "child must not use the parent's post-cutoff checkpoint",
    );
    const childPayload: ChildPayload = {
      label: "conversation child",
      recoveredLayerId: childRecoveredLayerId,
      sourceLayerId: published.forkPoint.layerId,
      sourceCheckpointId: published.forkPoint.checkpoint.checkpointId,
      basePath: published.basePath,
      expectedHex: Buffer.from(PUBLISHED_CONTENT).toString("hex"),
      forbiddenHex: [
        Buffer.from(PARENT_LATER_CONTENT).toString("hex"),
        Buffer.from(ORPHAN_CONTENT).toString("hex"),
      ],
      expectedDurableSeq: published.forkPoint.checkpoint.durableSeq,
      expectedDepth: published.forkPoint.checkpoint.depth + 1,
      expectedRootLayerId: published.rootLayerId,
    };
    assert.equal(
      spawnChildReader(childPayload),
      0,
      "fresh process must read the child fork-cutoff bytes by identity",
    );
    process.stdout.write("ASSERT 3 OK: conversation child recovered the fork-cutoff workspace\n");

    // ASSERT 4: fail-closed publication breach.
    await assertPublicationBreachFailsClosed(tracked, published);

  } catch (error) {
    runError = error;
  } finally {
    try {
      await cascadeAbandonAll(tracked);
    } catch (cleanupError) {
      if (runError !== undefined) {
        throw new AggregateError([runError, cleanupError], "E2E assertions and cleanup both failed");
      }
      throw cleanupError;
    }
  }
  if (runError !== undefined) throw runError;
  process.stdout.write(
    "PASS: real SDK cross-process recovery + conversation-fork cutoff E2E (cleanup verified)\n",
  );
}

async function main(): Promise<void> {
  if (process.env.DRIVE9_E2E_ROLE === "child") {
    try {
      await runChildReader();
      process.exit(0);
    } catch (error) {
      process.stderr.write(`CHILD-FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(3);
    }
  }
  await runParent();
}

await main();
