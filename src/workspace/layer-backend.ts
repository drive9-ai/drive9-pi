import type { Context } from "@earendil-works/chord";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Drive9ProtocolError, protocolCause } from "../core/errors.js";
import type { WorkspaceCoordinatorBackend } from "./coordinator.js";
import type { WorkspaceBinding, WritableWorkspaceHandle } from "./recovery.js";
import type {
  PublishedWorkspaceRef,
  VerifiedWorkspaceCheckpoint,
  WorkspaceCandidateData,
} from "./types.js";

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
  forkFSLayer(
    parentRef: string,
    request?: {
      readonly layer_id?: string;
      readonly name?: string;
      readonly actor_id?: string;
      readonly checkpoint_id?: string;
    },
  ): Promise<Drive9LayerRecord>;
  deleteFSLayer(layerId: string, options?: { readonly cascade?: boolean }): Promise<void>;
  checkpointFSLayer(
    layerId: string,
    request: { readonly checkpoint_id?: string; readonly label?: string },
  ): Promise<Drive9LayerCheckpointRecord>;
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
  compareAndSetBinding(
    input: WorkspaceBindingSwitch,
    context: Context,
  ): Promise<WorkspaceBindingSwitchReceipt>;
}

export type Drive9LayerWorkspaceBackendOptions = {
  readonly client: Drive9LayerWorkspaceClient;
  readonly bindings: Drive9LayerBindingStore;
};

type LayerLineage = {
  readonly layerId: string;
  readonly rootLayerId: string;
  readonly parentLayerId: string | null;
  readonly parentCheckpointId: string | null;
  readonly depth: number;
};

function requiredString(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Drive9ProtocolError("checkpoint_mismatch", `${label} must be a non-empty string`);
  }
  return normalized;
}

function optionalString(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function safeInteger(value: number, label: string, maximum?: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || (maximum !== undefined && value > maximum)) {
    throw new Drive9ProtocolError("checkpoint_mismatch", `${label} is outside the supported range`);
  }
  return value;
}

function lineage(layer: Drive9LayerRecord): LayerLineage {
  const layerId = requiredString(layer.layer_id, "layer ID");
  const parentLayerId = optionalString(layer.parent_layer_id);
  const parentCheckpointId = optionalString(layer.origin_checkpoint_id);
  const depth = safeInteger(layer.depth ?? 0, "layer depth", 16);
  const rootLayerId = optionalString(layer.root_layer_id) ?? (parentLayerId === null ? layerId : null);
  if (rootLayerId === null) {
    throw new Drive9ProtocolError("checkpoint_mismatch", "forked layer is missing its root lineage");
  }
  if (parentLayerId === null) {
    if (parentCheckpointId !== null || depth !== 0 || rootLayerId !== layerId) {
      throw new Drive9ProtocolError("checkpoint_mismatch", "root layer lineage is inconsistent");
    }
  } else if (parentCheckpointId === null || depth === 0) {
    throw new Drive9ProtocolError("checkpoint_mismatch", "forked layer is missing checkpoint lineage");
  }
  return { layerId, rootLayerId, parentLayerId, parentCheckpointId, depth };
}

function writableHandle(layer: Drive9LayerRecord): WritableWorkspaceHandle {
  const value = lineage(layer);
  if (value.parentLayerId === null || value.parentCheckpointId === null) {
    throw new Drive9ProtocolError("checkpoint_mismatch", "a writable recovery generation must be checkpoint-forked");
  }
  return {
    ...value,
    sourceCheckpointId: value.parentCheckpointId,
    executionEnvId: `drive9-layer:${value.layerId}`,
  };
}

function checkpoint(
  record: Drive9LayerCheckpointRecord,
  layer: Drive9LayerRecord,
): VerifiedWorkspaceCheckpoint {
  const layerLineage = lineage(layer);
  const checkpointId = requiredString(record.checkpoint_id, "checkpoint ID");
  const checkpointLayerId = requiredString(record.layer_id, "checkpoint layer ID");
  if (checkpointLayerId !== layerLineage.layerId) {
    throw new Drive9ProtocolError("checkpoint_mismatch", "checkpoint belongs to a different layer");
  }
  return {
    checkpointId,
    durableSeq: safeInteger(record.durable_seq, "checkpoint durable sequence"),
    ...layerLineage,
  };
}

function sameCheckpoint(left: VerifiedWorkspaceCheckpoint, right: VerifiedWorkspaceCheckpoint): boolean {
  return (
    left.checkpointId === right.checkpointId &&
    left.durableSeq === right.durableSeq &&
    left.layerId === right.layerId &&
    left.rootLayerId === right.rootLayerId &&
    left.parentLayerId === right.parentLayerId &&
    left.parentCheckpointId === right.parentCheckpointId &&
    left.depth === right.depth
  );
}

function sameHandle(left: WritableWorkspaceHandle, right: WritableWorkspaceHandle): boolean {
  return (
    left.layerId === right.layerId &&
    left.rootLayerId === right.rootLayerId &&
    left.parentLayerId === right.parentLayerId &&
    left.parentCheckpointId === right.parentCheckpointId &&
    left.sourceCheckpointId === right.sourceCheckpointId &&
    left.depth === right.depth &&
    left.executionEnvId === right.executionEnvId
  );
}

function sameBinding(left: StoredWorkspaceBinding, right: StoredWorkspaceBinding): boolean {
  return (
    Number(left.conversationId) === Number(right.conversationId) &&
    left.writerEpoch === right.writerEpoch &&
    left.publishedCandidateKey === right.publishedCandidateKey &&
    sameHandle(left.handle, right.handle)
  );
}

function throwIfAborted(context: Context): void {
  context.abortSignal?.throwIfAborted();
}

function conflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { readonly name?: unknown; readonly statusCode?: unknown };
  return value.statusCode === 409 || value.name === "ConflictError";
}

function recoveryFailure(message: string, error: unknown): Drive9ProtocolError {
  const cause = protocolCause(error);
  return new Drive9ProtocolError("recovery_failed", message, cause);
}

export class Drive9LayerWorkspaceBackend implements WorkspaceCoordinatorBackend {
  readonly #client: Drive9LayerWorkspaceClient;
  readonly #bindings: Drive9LayerBindingStore;

  constructor(options: Drive9LayerWorkspaceBackendOptions) {
    this.#client = options.client;
    this.#bindings = options.bindings;
  }

  async currentBinding(conversationId: ConversationId, context: Context): Promise<WorkspaceBinding | undefined> {
    throwIfAborted(context);
    const stored = await this.#bindings.readBinding(conversationId, context);
    throwIfAborted(context);
    if (stored === undefined) return undefined;
    if (Number(stored.conversationId) !== Number(conversationId)) {
      throw new Drive9ProtocolError("recovery_failed", "workspace binding belongs to a different conversation");
    }
    let layer: Drive9LayerRecord;
    try {
      layer = await this.#client.getFSLayer(stored.handle.layerId);
    } catch (error) {
      throw recoveryFailure("failed to read the bound LayerFS generation", error);
    }
    throwIfAborted(context);
    const handle = writableHandle(layer);
    if (!sameHandle(handle, stored.handle)) {
      throw new Drive9ProtocolError("recovery_failed", "stored workspace binding does not match LayerFS lineage");
    }
    const hasUnpublishedWrites = await this.#hasUnpublishedWrites(layer, context);
    return { ...stored, handle, hasUnpublishedWrites };
  }

  async forkFromCheckpoint(
    input: {
      readonly source: VerifiedWorkspaceCheckpoint;
      readonly childIdentity: string;
      readonly writerEpoch: string;
    },
    context: Context,
  ): Promise<{ readonly handle: WritableWorkspaceHandle; readonly hasUnpublishedWrites: boolean }> {
    throwIfAborted(context);
    const persistedSource = await this.#readCheckpoint(
      input.source.checkpointId,
      input.source.layerId,
      context,
    );
    if (!sameCheckpoint(persistedSource, input.source)) {
      throw new Drive9ProtocolError("checkpoint_mismatch", "recovery source no longer matches its persisted lineage");
    }

    let layer: Drive9LayerRecord;
    try {
      layer = await this.#client.forkFSLayer(input.source.layerId, {
        layer_id: input.childIdentity,
        checkpoint_id: input.source.checkpointId,
      });
    } catch (error) {
      if (!conflict(error)) throw recoveryFailure("failed to fork the published LayerFS checkpoint", error);
      try {
        layer = await this.#client.getFSLayer(input.childIdentity);
      } catch (readError) {
        throw recoveryFailure("conflicting recovery child could not be reconciled", readError);
      }
    }
    throwIfAborted(context);
    const handle = writableHandle(layer);
    if (
      handle.layerId !== input.childIdentity ||
      handle.parentLayerId !== input.source.layerId ||
      handle.parentCheckpointId !== input.source.checkpointId ||
      handle.sourceCheckpointId !== input.source.checkpointId ||
      handle.rootLayerId !== input.source.rootLayerId ||
      handle.depth !== input.source.depth + 1
    ) {
      throw new Drive9ProtocolError("checkpoint_mismatch", "recovery child does not match the requested lineage");
    }
    return {
      handle,
      hasUnpublishedWrites: await this.#hasUnpublishedWrites(layer, context),
    };
  }

  async switchBinding(input: WorkspaceBindingSwitch, context: Context): Promise<void> {
    throwIfAborted(context);
    let receipt: WorkspaceBindingSwitchReceipt;
    try {
      receipt = await this.#bindings.compareAndSetBinding(input, context);
    } catch (error) {
      throw recoveryFailure("workspace binding compare-and-set failed", error);
    }
    throwIfAborted(context);
    const expected: StoredWorkspaceBinding = {
      conversationId: input.conversationId,
      writerEpoch: input.writerEpoch,
      publishedCandidateKey: input.publishedCandidateKey,
      handle: input.handle,
    };
    if (receipt.previousLayerId !== input.expectedLayerId || !sameBinding(receipt.binding, expected)) {
      throw new Drive9ProtocolError("recovery_failed", "workspace binding compare-and-set receipt is inconsistent");
    }
  }

  async abandon(handle: WritableWorkspaceHandle, context: Context): Promise<void> {
    throwIfAborted(context);
    await this.#client.deleteFSLayer(handle.layerId, { cascade: false });
    throwIfAborted(context);
  }

  async checkpoint(
    input: {
      readonly handle: WritableWorkspaceHandle;
      readonly checkpointId: string;
      readonly writerEpoch: string;
      readonly previous: PublishedWorkspaceRef | null;
    },
    context: Context,
  ): Promise<VerifiedWorkspaceCheckpoint> {
    throwIfAborted(context);
    let created: Drive9LayerCheckpointRecord;
    try {
      created = await this.#client.checkpointFSLayer(input.handle.layerId, {
        checkpoint_id: input.checkpointId,
      });
    } catch (createError) {
      try {
        created = await this.#client.getFSLayerCheckpoint(input.checkpointId);
      } catch (readError) {
        throw new Drive9ProtocolError(
          "candidate_commit_unknown",
          "LayerFS checkpoint creation outcome could not be reconciled",
          protocolCause(readError),
        );
      }
      if (created.checkpoint_id !== input.checkpointId || created.layer_id !== input.handle.layerId) {
        throw new Drive9ProtocolError(
          "checkpoint_mismatch",
          "reconciled checkpoint does not match the requested identity",
          protocolCause(createError),
        );
      }
    }
    if (created.checkpoint_id !== input.checkpointId || created.layer_id !== input.handle.layerId) {
      throw new Drive9ProtocolError("checkpoint_mismatch", "created checkpoint does not match the requested identity");
    }
    let layer: Drive9LayerRecord;
    try {
      layer = await this.#client.getFSLayer(input.handle.layerId);
    } catch (error) {
      throw recoveryFailure("failed to read the checkpointed LayerFS generation", error);
    }
    throwIfAborted(context);
    const verified = checkpoint(created, layer);
    if (!sameHandle(writableHandle(layer), input.handle)) {
      throw new Drive9ProtocolError("checkpoint_mismatch", "checkpointed layer no longer matches the prepared generation");
    }
    return verified;
  }

  async readCheckpoint(
    input: { readonly checkpointId: string; readonly layerId: string },
    context: Context,
  ): Promise<VerifiedWorkspaceCheckpoint> {
    return this.#readCheckpoint(input.checkpointId, input.layerId, context);
  }

  async verify(candidate: WorkspaceCandidateData, context: Context): Promise<VerifiedWorkspaceCheckpoint> {
    return this.#readCheckpoint(candidate.checkpoint.checkpointId, candidate.checkpoint.layerId, context);
  }

  async #readCheckpoint(
    checkpointId: string,
    layerId: string,
    context: Context,
  ): Promise<VerifiedWorkspaceCheckpoint> {
    throwIfAborted(context);
    let record: Drive9LayerCheckpointRecord;
    try {
      record = await this.#client.getFSLayerCheckpoint(checkpointId);
    } catch (error) {
      throw new Drive9ProtocolError("checkpoint_mismatch", "failed to read the LayerFS checkpoint", protocolCause(error));
    }
    throwIfAborted(context);
    if (record.checkpoint_id !== checkpointId || record.layer_id !== layerId) {
      throw new Drive9ProtocolError("checkpoint_mismatch", "LayerFS checkpoint identity does not match the request");
    }
    let layer: Drive9LayerRecord;
    try {
      layer = await this.#client.getFSLayer(layerId);
    } catch (error) {
      throw new Drive9ProtocolError("checkpoint_mismatch", "failed to read the checkpoint layer", protocolCause(error));
    }
    throwIfAborted(context);
    return checkpoint(record, layer);
  }

  async #hasUnpublishedWrites(layer: Drive9LayerRecord, context: Context): Promise<boolean> {
    if (layer.state !== "active") return true;
    let events: Drive9LayerEventRecord[];
    try {
      events = await this.#client.listFSLayerEvents(layer.layer_id, 0);
    } catch (error) {
      throw recoveryFailure("failed to inspect LayerFS generation events", error);
    }
    throwIfAborted(context);
    for (const event of events) {
      if (event.layer_id !== layer.layer_id || !Number.isSafeInteger(event.seq) || event.seq < 0) {
        throw new Drive9ProtocolError("recovery_failed", "LayerFS event stream contains inconsistent lineage");
      }
    }
    return events.length > 0;
  }
}
