import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
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
  drain: (signal?: AbortSignal) => Promise<void>;
  checkpointLabel?: string;
  checkpointId?: () => string | undefined;
}

export interface Drive9MountDrainOptions {
  mountPoint: string;
  drive9Path?: string;
  timeoutSeconds?: number;
  environment?: Record<string, string>;
}

function valueError(value: unknown): Error {
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
  private readonly drain: (signal?: AbortSignal) => Promise<void>;
  private readonly checkpointLabel: string | undefined;
  private readonly checkpointId: (() => string | undefined) | undefined;
  private captureTail: Promise<void> = Promise.resolve();

  constructor(options: Drive9LayerWorkspaceRevisionProviderOptions) {
    this.client = options.client;
    this.layerId = requireNonEmpty(options.layerId, "layerId");
    this.drain = options.drain;
    this.checkpointLabel = options.checkpointLabel;
    this.checkpointId = options.checkpointId;
  }

  async capture(signal?: AbortSignal): Promise<WorkspaceRevision> {
    const operation = async (): Promise<WorkspaceRevision> => {
      if (signal?.aborted) throw new ResultStoreError("aborted", "workspace revision capture was aborted");
      try {
        await this.drain(signal);
      } catch (error) {
        if (error instanceof ResultStoreError) throw error;
        throw new ResultStoreError("unavailable", "Drive9 mount drain failed", valueError(error));
      }
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
        throw new ResultStoreError("unavailable", "Drive9 layer checkpoint failed", valueError(error));
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

export function selectDrive9MountDrainEnvironment(
  environment: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  if (environment !== undefined) return { ...environment };
  const selected: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "TMPDIR", "XDG_RUNTIME_DIR"]) {
    const value = process.env[name];
    if (value !== undefined) selected[name] = value;
  }
  return selected;
}

export function createDrive9MountDrain(options: Drive9MountDrainOptions): (signal?: AbortSignal) => Promise<void> {
  const mountPoint = requireNonEmpty(options.mountPoint, "mountPoint");
  if (!isAbsolute(mountPoint)) throw new ResultStoreError("invalid", "mountPoint must be absolute");
  const drive9Path = options.drive9Path ?? "/usr/local/bin/drive9";
  if (!isAbsolute(drive9Path)) throw new ResultStoreError("invalid", "drive9Path must be absolute");
  const timeoutSeconds = options.timeoutSeconds ?? 30;
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) {
    throw new ResultStoreError("invalid", "timeoutSeconds must be between 1 and 300");
  }
  const environment = selectDrive9MountDrainEnvironment(options.environment);
  return async (signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) throw new ResultStoreError("aborted", "Drive9 mount drain was aborted");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        drive9Path,
        ["mount", "drain", `--timeout=${timeoutSeconds}s`, "--json", mountPoint],
        { env: environment, stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      let settled = false;
      const finish = (error?: ResultStoreError): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (error === undefined) resolve();
        else reject(error);
      };
      const onAbort = (): void => {
        child.kill("SIGTERM");
        finish(new ResultStoreError("aborted", "Drive9 mount drain was aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        if (Buffer.byteLength(stderr, "utf8") < 4096) stderr += chunk.toString();
      });
      child.once("error", (error) => {
        finish(new ResultStoreError("unavailable", "failed to start Drive9 mount drain", error));
      });
      child.once("close", (code, childSignal) => {
        if (signal?.aborted) return;
        if (code === 0) {
          finish();
          return;
        }
        const detail = stderr.trim();
        const suffix = detail.length === 0 ? "" : `: ${detail.slice(0, 4096)}`;
        finish(
          new ResultStoreError(
            "unavailable",
            `Drive9 mount drain exited with ${code ?? childSignal ?? "unknown"}${suffix}`,
          ),
        );
      });
    });
  };
}
