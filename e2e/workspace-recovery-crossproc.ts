/**
 * REAL-backend, cross-process restore-by-fork recovery E2E for drive9-pi.
 *
 * This script exercises the actual {@link recoverWorkspace} pipeline against the
 * real {@link Drive9LayerWorkspaceBackend}, which forks a fresh LayerFS
 * generation from the PUBLISHED checkpoint on the live Drive9 server
 * (`~/.drive9/config` -> `Client.defaultClient()`).
 *
 * It proves three things that a broken implementation would fail:
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
 *      published bytes. Recovery must still fork from the published checkpoint,
 *      so the recovered + cross-process-read bytes equal the PUBLISHED content
 *      and NOT the orphan content, the recovered layer is a NEW generation
 *      (different layerId), and it carries no inherited writes (0 events).
 *
 *   3. Fail-closed on a publication breach. A published candidate whose root
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
  VerifiedWorkspaceCheckpoint,
  WorkspaceMutationPlan,
} from "../src/workspace/types.js";

const LAYER_PREFIX = "dev1-e2e-";
const FILE_NAME = "state.txt";
const PUBLISHED_CONTENT = "dev1-e2e PUBLISHED workspace bytes\n";
const ORPHAN_CONTENT = "dev1-e2e ORPHAN unpublished bytes (must NOT be recovered)\n";

// ---------------------------------------------------------------------------
// Thin Drive9LayerWorkspaceClient adapter over the installed `drive9` SDK.
//
// The installed drive9@0.1.4 SDK does not surface forkFSLayer/deleteFSLayer as
// methods, but the live server supports them at
//   POST   /v1/layers/{id}/fork   { checkpoint_id, layer_id?, name? }
//   DELETE /v1/layers/{id}?cascade=...
// (verified against api.drive9.ai). This adapter consumes the REAL client for
// every other call and bridges those two verbs via raw fetch; it is pure test
// scaffolding and changes nothing in src/.
// ---------------------------------------------------------------------------
type ServerLayerRecord = {
  readonly layer_id: string;
  readonly state: string;
  readonly durable_seq: number;
  readonly parent_layer_id?: string;
  readonly origin_checkpoint_id?: string;
  readonly root_layer_id?: string;
  readonly depth?: number;
};
type ServerCheckpointRecord = {
  readonly checkpoint_id: string;
  readonly layer_id: string;
  readonly durable_seq: number;
};
type ServerEventRecord = { readonly layer_id: string; readonly seq: number };

function rawBase(client: Client): string {
  return client.baseURL().replace(/\/+$/, "");
}

async function forkLayer(
  client: Client,
  parentLayerId: string,
  request: { readonly layer_id?: string; readonly name?: string; readonly checkpoint_id?: string },
): Promise<ServerLayerRecord> {
  const res = await withRetry(`forkFSLayer ${parentLayerId}`, 3, () =>
    fetch(`${rawBase(client)}/v1/layers/${encodeURIComponent(parentLayerId)}/fork`, {
      method: "POST",
      headers: client.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(request),
    }),
  );
  if (!res.ok) {
    const error = new Error(`forkFSLayer ${res.status}: ${(await res.text()).slice(0, 200)}`) as Error & {
      statusCode?: number;
    };
    error.statusCode = res.status;
    throw error;
  }
  return (await res.json()) as ServerLayerRecord;
}

async function deleteLayer(client: Client, layerId: string, cascade: boolean): Promise<void> {
  const suffix = cascade ? "?cascade=true" : "";
  const res = await withRetry(`deleteFSLayer ${layerId}`, 3, () =>
    fetch(`${rawBase(client)}/v1/layers/${encodeURIComponent(layerId)}${suffix}`, {
      method: "DELETE",
      headers: client.authHeaders(),
    }),
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`deleteFSLayer ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

function layerClient(client: Client): Drive9LayerWorkspaceClient {
  return {
    getFSLayer: (layerId) => client.getFSLayer(layerId) as unknown as Promise<ServerLayerRecord>,
    forkFSLayer: (parentRef, request) => forkLayer(client, parentRef, request ?? {}),
    deleteFSLayer: (layerId, options) => deleteLayer(client, layerId, options?.cascade ?? false),
    checkpointFSLayer: (layerId, request) =>
      client.checkpointFSLayer(layerId, request) as unknown as Promise<ServerCheckpointRecord>,
    getFSLayerCheckpoint: (checkpointId) =>
      client.getFSLayerCheckpoint(checkpointId) as unknown as Promise<ServerCheckpointRecord>,
    listFSLayerEvents: (layerId, since) =>
      client.listFSLayerEvents(layerId, since) as unknown as Promise<ServerEventRecord[]>,
  };
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
  readonly created: Set<string>;
  readonly basePaths: Set<string>;
};

function trackedClient(): Tracked {
  return { client: Client.defaultClient(), created: new Set(), basePaths: new Set() };
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

function filePath(base: string): string {
  return `${base}/${FILE_NAME}`;
}

// Build the real server layout:
//   R  (root, depth 0)              -- checkpoint cpR
//   P  = fork(R @ cpR)              -- PUBLISHED generation; bytes = PUBLISHED_CONTENT
//        checkpoint cpP, id == candidateKey (pic_...)   <- the published source
//   O  = fork(P @ cpP)              -- LATER orphan; bytes = ORPHAN_CONTENT (DIFFERENT)
//        checkpoint cpO (later physical checkpoint, never published)
// then seed MemoryStorage so resolvePublishedWorkspace() selects cpP on P.
type Published = {
  readonly storage: MemoryStorage;
  readonly conversationId: ConversationId;
  readonly writerEpoch: string;
  readonly rootLayerId: string;
  readonly rootCheckpointId: string;
  readonly publishedLayerId: string;
  readonly publishedCheckpointId: string;
  readonly publishedCheckpoint: VerifiedWorkspaceCheckpoint;
  readonly initialCheckpoint: VerifiedWorkspaceCheckpoint;
  readonly sessionId: string;
  readonly basePath: string;
};

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

  // Published generation P = fork(R @ cpR); write PUBLISHED bytes.
  const publishedLayerId = `${LAYER_PREFIX}pub-${randomUUID().slice(0, 12).replace(/-/g, "")}`;
  tracked.created.add(publishedLayerId);
  const published = await forkLayer(client, root.layer_id, {
    layer_id: publishedLayerId,
    name: `${LAYER_PREFIX}published`,
    checkpoint_id: rootCheckpointId,
  });
  assert.equal(published.layer_id, publishedLayerId, "published layer identity");
  await client.uploadFSLayerFile(published.layer_id, filePath(basePath), Buffer.from(PUBLISHED_CONTENT));

  // The published checkpoint id must equal the Drive9 candidate digest for the
  // attempt that publishes P's generation. Build the publication record first,
  // then checkpoint P on the server with exactly that id.
  const storage = new MemoryStorage();
  const conversationId = await storage.mintId<ConversationId>();
  await storage.commit([{ type: "conversation", value: { id: conversationId } }], BACKGROUND_CONTEXT);
  const taskId = await storage.mintId<TaskId<JsonValue>>();
  const attemptId = await storage.mintId<EntryId>();
  const candidateId = await storage.mintId<EntryId>();
  const resultId = await storage.mintId<EntryId>();

  const plan: WorkspaceMutationPlan = {
    sessionId,
    writerEpoch,
    workspace: {
      layerId: published.layer_id,
      rootLayerId: root.layer_id,
      parentLayerId: root.layer_id,
      parentCheckpointId: rootCheckpointId,
      depth: 1,
      executionEnvId: `drive9-layer:${published.layer_id}`,
    },
    previous: null,
  };
  const attempt = buildWorkspaceAttemptData({
    conversationId: Number(conversationId),
    taskId: Number(taskId),
    toolCallId: "call-published",
    effect: "workspace",
    plan,
  });
  const publishedCheckpointId = deriveWorkspaceCandidateKey(attempt, attemptId);

  const cpP = await client.checkpointFSLayer(published.layer_id, {
    checkpoint_id: publishedCheckpointId,
    label: `${LAYER_PREFIX}published`,
  });
  const publishedCheckpoint: VerifiedWorkspaceCheckpoint = {
    checkpointId: publishedCheckpointId,
    durableSeq: cpP.durable_seq,
    layerId: published.layer_id,
    rootLayerId: root.layer_id,
    parentLayerId: root.layer_id,
    parentCheckpointId: rootCheckpointId,
    depth: 1,
  };

  const candidate = buildWorkspaceCandidateData({ attempt, attemptId, checkpoint: publishedCheckpoint });

  const writes: StorageWrite[] = [
    {
      type: "entry",
      value: {
        id: attemptId,
        conversationId,
        kind: WorkspaceAttemptEntry.kind,
        data: attempt,
        byTaskId: taskId,
      },
    },
    {
      type: "entry",
      value: {
        id: candidateId,
        conversationId,
        kind: WorkspaceCandidateEntry.kind,
        data: candidate,
        byTaskId: taskId,
      },
    },
    {
      type: "entry",
      value: {
        id: resultId,
        conversationId,
        kind: "pi.tool-result",
        model: [
          {
            role: "toolResult",
            toolCallId: "call-published",
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
        conversationId,
        kind: "pi.tool",
        version: 1,
        input: { assistant: 1, callId: "call-published" },
        background: false,
        abortRequested: false,
        state: { status: "terminal", outcome: { status: "completed", result: { entryId: resultId } } },
      },
    },
  ];
  await storage.commit(writes, BACKGROUND_CONTEXT);

  // LATER orphan O = fork(P @ cpP) with DIFFERENT bytes + its own checkpoint.
  // This is the "latest physical checkpoint" that a broken recovery might
  // wrongly select. It is never published (no storage record references it).
  const orphanLayerId = `${LAYER_PREFIX}orphan-${randomUUID().slice(0, 12).replace(/-/g, "")}`;
  tracked.created.add(orphanLayerId);
  const orphan = await forkLayer(client, published.layer_id, {
    layer_id: orphanLayerId,
    name: `${LAYER_PREFIX}orphan`,
    checkpoint_id: publishedCheckpointId,
  });
  assert.equal(orphan.layer_id, orphanLayerId, "orphan layer identity");
  await client.uploadFSLayerFile(orphan.layer_id, filePath(basePath), Buffer.from(ORPHAN_CONTENT));
  const orphanCheckpointId = `dev1e2ecpo${stamp}${randomUUID().slice(0, 8).replace(/-/g, "")}`;
  await client.checkpointFSLayer(orphan.layer_id, {
    checkpoint_id: orphanCheckpointId,
    label: `${LAYER_PREFIX}orphan`,
  });

  const initialCheckpoint: VerifiedWorkspaceCheckpoint = {
    checkpointId: rootCheckpointId,
    durableSeq: rootCheckpoint.durable_seq,
    layerId: root.layer_id,
    rootLayerId: root.layer_id,
    parentLayerId: null,
    parentCheckpointId: null,
    depth: 0,
  };

  return {
    storage,
    conversationId,
    writerEpoch,
    rootLayerId: root.layer_id,
    rootCheckpointId,
    publishedLayerId: published.layer_id,
    publishedCheckpointId,
    publishedCheckpoint,
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
      await deleteLayer(tracked.client, layerId, true);
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
  readonly recoveredLayerId: string;
  readonly publishedLayerId: string;
  readonly publishedCheckpointId: string;
  readonly basePath: string;
  readonly expectedPublishedHex: string;
  readonly orphanHex: string;
  readonly expectedDurableSeq: number;
  readonly expectedDepth: number;
  readonly expectedRootLayerId: string;
  readonly expectedParentCheckpointId: string;
};

async function runChildReader(): Promise<void> {
  const payload = JSON.parse(process.env.DRIVE9_E2E_PAYLOAD ?? "{}") as ChildPayload;
  const client = Client.defaultClient(); // independent process, independent connection
  await withRetry("child.warm", 3, async () => {
    await client.warm();
  });

  // (a) Read the recovered layer's bytes from a fresh process.
  const recoveredBytes = Buffer.from(
    await withRetry("child.read", 3, () => client.readFSLayerFile(payload.recoveredLayerId, filePath(payload.basePath))),
  );
  const expectedPublished = Buffer.from(payload.expectedPublishedHex, "hex");
  const orphan = Buffer.from(payload.orphanHex, "hex");

  assert.ok(expectedPublished.equals(recoveredBytes), "recovered bytes must equal the PUBLISHED content");
  assert.ok(!orphan.equals(recoveredBytes), "recovered bytes must NOT equal the ORPHAN content");

  // (b) Independently resolve the published checkpoint identity + lineage.
  const checkpoint = (await withRetry("child.getCheckpoint", 3, () =>
    client.getFSLayerCheckpoint(payload.publishedCheckpointId),
  )) as unknown as ServerCheckpointRecord;
  assert.equal(checkpoint.checkpoint_id, payload.publishedCheckpointId, "checkpoint identity");
  assert.equal(checkpoint.layer_id, payload.publishedLayerId, "checkpoint belongs to the published layer");
  assert.equal(checkpoint.durable_seq, payload.expectedDurableSeq, "checkpoint durable sequence");

  // (c) Independently confirm the recovered layer is a fresh fork of P@cpP.
  const recovered = (await withRetry("child.getLayer", 3, () =>
    client.getFSLayer(payload.recoveredLayerId),
  )) as unknown as ServerLayerRecord;
  assert.notEqual(recovered.layer_id, payload.publishedLayerId, "recovered layer is a NEW generation");
  assert.equal(recovered.parent_layer_id, payload.publishedLayerId, "recovered parent is the published layer");
  assert.equal(
    recovered.origin_checkpoint_id,
    payload.expectedParentCheckpointId,
    "recovered layer forked from the published checkpoint",
  );
  assert.equal(recovered.root_layer_id, payload.expectedRootLayerId, "recovered root lineage");
  assert.equal(recovered.depth, payload.expectedDepth, "recovered depth = published depth + 1");
  const recoveredEvents = await withRetry("child.listEvents", 3, () =>
    client.listFSLayerEvents(payload.recoveredLayerId, 0),
  );
  assert.equal(recoveredEvents.length, 0, "recovered generation starts without unpublished events");

  process.stdout.write("CHILD-OK: cross-process read matches the published checkpoint exactly\n");
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
    client: countingLayerClient(layerClient(tracked.client), counter),
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
    "ASSERT 3 OK: foreign-root recovery fails closed (publication_breach) with ZERO backend mutation\n",
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

    const backend = new Drive9LayerWorkspaceBackend({
      client: layerClient(tracked.client),
      bindings: new InMemoryBindings(),
    });

    // Drive the REAL recovery pipeline against the live server.
    const recovered = await recoverWorkspace({
      storage: published.storage,
      conversationId: published.conversationId,
      expectedSessionId: published.sessionId,
      initialCheckpoint: published.initialCheckpoint,
      verifier: backend,
      backend,
      context: BACKGROUND_CONTEXT,
      maxLayerDepth: 16,
      mode: { kind: "single-coordinator-preview", writerEpoch: published.writerEpoch },
    });
    const recoveredLayerId = recovered.binding.handle.layerId;
    tracked.created.add(recoveredLayerId);

    // ASSERT 2: recovery selected the PUBLISHED checkpoint as its source and
    // forked a NEW generation from it (not latest-physical, not in-place).
    assert.equal(
      recovered.published?.data.checkpoint.checkpointId,
      published.publishedCheckpointId,
      "recovery resolved the PUBLISHED checkpoint",
    );
    assert.equal(
      recovered.binding.handle.parentCheckpointId,
      published.publishedCheckpointId,
      "recovered generation forked from the published checkpoint",
    );
    assert.equal(
      recovered.binding.handle.parentLayerId,
      published.publishedLayerId,
      "recovered generation parent is the published layer",
    );
    assert.notEqual(
      recoveredLayerId,
      published.publishedLayerId,
      "recovered generation is a NEW layer, not in-place",
    );
    assert.equal(recovered.binding.hasUnpublishedWrites, false, "recovered generation has no inherited writes");
    assert.equal(recovered.binding.handle.depth, published.publishedCheckpoint.depth + 1, "depth = published + 1");
    process.stdout.write("ASSERT 2 OK: recovery forked a fresh generation from the PUBLISHED checkpoint\n");

    // ASSERT 1: TRUE cross-process read + byte-exact match of PUBLISHED (not ORPHAN).
    const payload: ChildPayload = {
      recoveredLayerId,
      publishedLayerId: published.publishedLayerId,
      publishedCheckpointId: published.publishedCheckpointId,
      basePath: published.basePath,
      expectedPublishedHex: Buffer.from(PUBLISHED_CONTENT).toString("hex"),
      orphanHex: Buffer.from(ORPHAN_CONTENT).toString("hex"),
      expectedDurableSeq: published.publishedCheckpoint.durableSeq,
      expectedDepth: published.publishedCheckpoint.depth + 1,
      expectedRootLayerId: published.rootLayerId,
      expectedParentCheckpointId: published.publishedCheckpointId,
    };
    const childStatus = spawnChildReader(payload);
    assert.equal(childStatus, 0, "fresh child process must read the published bytes by identity (exit 0)");
    process.stdout.write("ASSERT 1 OK: independent child process read the recovered published bytes\n");

    // ASSERT 3: fail-closed publication breach.
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
  process.stdout.write("PASS: real cross-process restore-by-fork recovery E2E (cleanup verified)\n");
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
