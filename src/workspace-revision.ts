import type { FSLayerCheckpoint, FSLayerCheckpointRequest } from "drive9";
import { ResultStoreError, type WorkspaceRevision } from "./tool-result-types.js";

export interface WorkspaceRevisionProvider {
  capture(signal?: AbortSignal): Promise<WorkspaceRevision>;
}

export interface Drive9CheckpointClient {
  checkpointFSLayer(layerId: string, request: FSLayerCheckpointRequest): Promise<FSLayerCheckpoint>;
}

export interface Drive9LayerWorkspaceRevisionProviderOptions {
  client: Drive9CheckpointClient;
  layerId: string;
  checkpointLabel?: string;
  checkpointId?: () => string | undefined;
}

function errorValue(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" ? value : String(value));
}

function requireNonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new ResultStoreError("invalid", `${label} must be non-empty`);
  }
  return value;
}

function normalizeCheckpoint(checkpoint: FSLayerCheckpoint, layerId: string): WorkspaceRevision {
  if (checkpoint.layer_id !== layerId) {
    throw new ResultStoreError("corrupt", "checkpoint layer identity does not match the requested layer");
  }
  if (!Number.isSafeInteger(checkpoint.durable_seq) || checkpoint.durable_seq < 0) {
    throw new ResultStoreError("corrupt", "checkpoint durable sequence is invalid");
  }
  if (typeof checkpoint.checkpoint_id !== "string" || checkpoint.checkpoint_id.length === 0) {
    throw new ResultStoreError("corrupt", "checkpoint id is missing");
  }
  if (typeof checkpoint.created_at !== "string" || !Number.isFinite(Date.parse(checkpoint.created_at))) {
    throw new ResultStoreError("corrupt", "checkpoint capture time is invalid");
  }
  return {
    layerId,
    durableSeq: checkpoint.durable_seq,
    snapshotId: checkpoint.checkpoint_id,
    capturedAt: new Date(checkpoint.created_at).toISOString(),
  };
}

export class Drive9LayerWorkspaceRevisionProvider implements WorkspaceRevisionProvider {
  private readonly client: Drive9CheckpointClient;
  private readonly layerId: string;
  private readonly checkpointLabel: string | undefined;
  private readonly checkpointId: (() => string | undefined) | undefined;
  private captureTail: Promise<void> = Promise.resolve();

  constructor(options: Drive9LayerWorkspaceRevisionProviderOptions) {
    this.client = options.client;
    this.layerId = requireNonEmpty(options.layerId, "layerId");
    this.checkpointLabel = options.checkpointLabel;
    this.checkpointId = options.checkpointId;
  }

  async capture(signal?: AbortSignal): Promise<WorkspaceRevision> {
    const operation = async (): Promise<WorkspaceRevision> => {
      if (signal?.aborted) throw new ResultStoreError("aborted", "workspace revision capture was aborted");
      const checkpointId = this.checkpointId?.();
      const request: FSLayerCheckpointRequest = {
        ...(this.checkpointLabel === undefined ? {} : { label: this.checkpointLabel }),
        ...(checkpointId === undefined ? {} : { checkpoint_id: checkpointId }),
      };
      try {
        return normalizeCheckpoint(await this.client.checkpointFSLayer(this.layerId, request), this.layerId);
      } catch (error) {
        if (error instanceof ResultStoreError) throw error;
        throw new ResultStoreError("unavailable", "Drive9 layer checkpoint failed", errorValue(error));
      }
    };
    const running = this.captureTail.then(operation, operation);
    this.captureTail = running.then(
      () => undefined,
      () => undefined,
    );
    return await running;
  }
}
