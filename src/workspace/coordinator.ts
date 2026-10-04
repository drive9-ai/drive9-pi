import type { Context, JsonValue } from "@earendil-works/chord";
import type { ConversationId, Storage } from "@earendil-works/pi-durable";
import { Drive9ProtocolError } from "../core/errors.js";
import { canonicalJson } from "../core/identity.js";
import { requireServerFencedStorage } from "../storage/profile.js";
import { buildWorkspaceAttemptData, deriveWorkspaceCandidateKey } from "./entries.js";
import {
  recoverWorkspace,
  type WorkspaceBinding,
  type WorkspaceRecoveryBackend,
  type WorkspaceRecoveryMode,
  type WritableWorkspaceHandle,
} from "./recovery.js";
import type {
  PublishedWorkspaceCandidate,
  PublishedWorkspaceRef,
  VerifiedWorkspaceCheckpoint,
  WorkspaceCandidateVerifier,
  WorkspaceCheckpointRequest,
  WorkspaceGeneration,
  WorkspaceMutationCoordinator,
  WorkspaceMutationPlan,
} from "./types.js";

export interface WorkspaceCoordinatorBackend extends WorkspaceRecoveryBackend, WorkspaceCandidateVerifier {
  /** Returns only after every included write is durably recoverable from another process. */
  checkpoint(
    input: {
      readonly handle: WritableWorkspaceHandle;
      readonly checkpointId: string;
      readonly writerEpoch: string;
      readonly previous: PublishedWorkspaceRef | null;
    },
    context: Context,
  ): Promise<VerifiedWorkspaceCheckpoint>;
  /** Independently reads the persisted checkpoint instead of trusting the create response. */
  readCheckpoint(
    input: { readonly checkpointId: string; readonly layerId: string },
    context: Context,
  ): Promise<VerifiedWorkspaceCheckpoint>;
}

export type Drive9WorkspaceCoordinatorOptions = {
  readonly sessionId: string;
  readonly storage: Storage;
  readonly backend: WorkspaceCoordinatorBackend;
  readonly initialCheckpoint: (
    conversationId: ConversationId,
    context: Context,
  ) => Promise<VerifiedWorkspaceCheckpoint>;
  readonly maxLayerDepth: number;
  readonly mode: WorkspaceRecoveryMode;
  readonly onAbandonError?: (error: Error) => void;
  readonly onPoison?: (error: Drive9ProtocolError, context: Context) => void | Promise<void>;
};

type PreparedWorkspace = {
  readonly conversationId: ConversationId;
  readonly taskId: number;
  readonly toolCallId: string;
  readonly effect: "workspace" | "workspace+external";
  readonly binding: WorkspaceBinding;
};

function exactJson(left: JsonValue, right: JsonValue): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function exactCheckpoint(left: VerifiedWorkspaceCheckpoint, right: VerifiedWorkspaceCheckpoint): boolean {
  return exactJson(left as JsonValue, right as JsonValue);
}

function generation(handle: WritableWorkspaceHandle): WorkspaceGeneration {
  return {
    layerId: handle.layerId,
    rootLayerId: handle.rootLayerId,
    parentLayerId: handle.parentLayerId,
    parentCheckpointId: handle.parentCheckpointId,
    depth: handle.depth,
    executionEnvId: handle.executionEnvId,
  };
}

function publishedRef(candidate: PublishedWorkspaceCandidate | undefined): PublishedWorkspaceRef | null {
  if (candidate === undefined) return null;
  return {
    candidateKey: candidate.data.candidateKey,
    checkpointId: candidate.data.checkpoint.checkpointId,
    durableSeq: candidate.data.checkpoint.durableSeq,
    layerId: candidate.data.checkpoint.layerId,
    rootLayerId: candidate.data.checkpoint.rootLayerId,
    depth: candidate.data.checkpoint.depth,
  };
}

function expectedCheckpoint(
  checkpoint: VerifiedWorkspaceCheckpoint,
  checkpointId: string,
  workspace: WorkspaceGeneration,
): boolean {
  return (
    checkpoint.checkpointId === checkpointId &&
    checkpoint.layerId === workspace.layerId &&
    checkpoint.rootLayerId === workspace.rootLayerId &&
    checkpoint.parentLayerId === workspace.parentLayerId &&
    checkpoint.parentCheckpointId === workspace.parentCheckpointId &&
    checkpoint.depth === workspace.depth
  );
}

function sameBinding(left: WorkspaceBinding, right: WorkspaceBinding): boolean {
  return (
    Number(left.conversationId) === Number(right.conversationId) &&
    left.writerEpoch === right.writerEpoch &&
    left.publishedCandidateKey === right.publishedCandidateKey &&
    exactJson(left.handle as unknown as JsonValue, right.handle as unknown as JsonValue)
  );
}

export class Drive9WorkspaceCoordinator implements WorkspaceMutationCoordinator {
  readonly #options: Drive9WorkspaceCoordinatorOptions;
  readonly #prepared = new WeakMap<WorkspaceMutationPlan, PreparedWorkspace>();
  readonly #taintedLayers = new Set<string>();
  #poisoned: Drive9ProtocolError | undefined;

  constructor(options: Drive9WorkspaceCoordinatorOptions) {
    if (options.sessionId.length === 0) {
      throw new Drive9ProtocolError("invalid_protocol_record", "session ID must be a non-empty string");
    }
    this.#options = options;
  }

  async prepare(
    input: Parameters<WorkspaceMutationCoordinator["prepare"]>[0],
    context: Context,
  ): Promise<WorkspaceMutationPlan> {
    this.#assertUsable();
    const initial = await this.#options.initialCheckpoint(input.conversationId, context);
    const verifiedInitial = await this.#options.backend.readCheckpoint(
      { checkpointId: initial.checkpointId, layerId: initial.layerId },
      context,
    );
    if (!exactCheckpoint(initial, verifiedInitial)) {
      throw new Drive9ProtocolError("checkpoint_mismatch", "initial workspace checkpoint verification failed");
    }

    const recovered = await recoverWorkspace({
      storage: this.#options.storage,
      conversationId: input.conversationId,
      expectedSessionId: this.#options.sessionId,
      initialCheckpoint: initial,
      verifier: this.#options.backend,
      backend: this.#recoveryBackend(),
      context,
      maxLayerDepth: this.#options.maxLayerDepth,
      mode: this.#options.mode,
      ...(this.#options.onAbandonError === undefined
        ? {}
        : { onAbandonError: this.#options.onAbandonError }),
    });
    if (input.env === undefined || input.env.id !== recovered.binding.handle.executionEnvId) {
      throw new Drive9ProtocolError(
        "execution_env_mismatch",
        "Pi tools and shell must use the recovered Drive9 workspace namespace",
      );
    }
    const plan: WorkspaceMutationPlan = {
      sessionId: this.#options.sessionId,
      writerEpoch: recovered.binding.writerEpoch,
      workspace: generation(recovered.binding.handle),
      previous: publishedRef(recovered.published),
    };
    this.#prepared.set(plan, {
      conversationId: input.conversationId,
      taskId: Number(input.taskId),
      toolCallId: input.toolCallId,
      effect: input.effect,
      binding: recovered.binding,
    });
    this.#taintedLayers.delete(recovered.binding.handle.layerId);
    return plan;
  }

  async checkpointAndVerify(
    request: WorkspaceCheckpointRequest,
    context: Context,
  ): Promise<VerifiedWorkspaceCheckpoint> {
    this.#assertUsable();
    const prepared = this.#prepared.get(request.plan);
    if (
      prepared === undefined ||
      Number(prepared.conversationId) !== Number(request.conversationId) ||
      prepared.taskId !== Number(request.taskId) ||
      prepared.toolCallId !== request.toolCallId ||
      prepared.effect !== request.effect
    ) {
      throw new Drive9ProtocolError("recovery_failed", "workspace mutation plan was not prepared by this coordinator");
    }
    const attempt = buildWorkspaceAttemptData({
      conversationId: Number(request.conversationId),
      taskId: Number(request.taskId),
      toolCallId: request.toolCallId,
      effect: request.effect,
      plan: request.plan,
    });
    if (deriveWorkspaceCandidateKey(attempt, request.attemptId) !== request.checkpointId) {
      throw new Drive9ProtocolError("invalid_protocol_record", "checkpoint ID does not match the workspace attempt");
    }
    this.#assertWriterEpoch(request.plan.writerEpoch);
    if (this.#taintedLayers.has(request.plan.workspace.layerId)) {
      throw new Drive9ProtocolError("recovery_failed", "tainted workspace generation cannot be checkpointed");
    }
    await this.#assertCurrentBinding(prepared, request.plan, context);

    const created = await this.#options.backend.checkpoint(
      {
        handle: prepared.binding.handle,
        checkpointId: request.checkpointId,
        writerEpoch: request.plan.writerEpoch,
        previous: request.plan.previous,
      },
      context,
    );
    if (!expectedCheckpoint(created, request.checkpointId, request.plan.workspace)) {
      throw new Drive9ProtocolError("checkpoint_mismatch", "created checkpoint does not match the prepared workspace");
    }
    const verified = await this.#options.backend.readCheckpoint(
      { checkpointId: request.checkpointId, layerId: request.plan.workspace.layerId },
      context,
    );
    if (!exactCheckpoint(created, verified)) {
      throw new Drive9ProtocolError("checkpoint_mismatch", "checkpoint create and independent read disagree");
    }
    await this.#assertCurrentBinding(prepared, request.plan, context);
    return verified;
  }

  invalidate(plan: WorkspaceMutationPlan): void {
    const prepared = this.#prepared.get(plan);
    if (prepared !== undefined) this.#taintedLayers.add(prepared.binding.handle.layerId);
  }

  async poison(error: Error, context: Context): Promise<never> {
    const poison =
      error instanceof Drive9ProtocolError
        ? error
        : new Drive9ProtocolError("session_poisoned", "Drive9 workspace session is poisoned", error);
    this.#poisoned ??= poison;
    try {
      await this.#options.onPoison?.(this.#poisoned, context);
    } finally {
      throw this.#poisoned;
    }
  }

  #assertUsable(): void {
    if (this.#poisoned !== undefined) {
      throw new Drive9ProtocolError(
        "session_poisoned",
        "Drive9 workspace session cannot continue after an unknown publication outcome",
        this.#poisoned,
      );
    }
  }

  #assertWriterEpoch(expected: string): void {
    const actual =
      this.#options.mode.kind === "stable"
        ? requireServerFencedStorage(this.#options.storage).writerEpoch
        : this.#options.mode.writerEpoch;
    if (actual !== expected) {
      throw new Drive9ProtocolError("recovery_failed", "workspace writer epoch changed during tool execution");
    }
  }

  async #assertCurrentBinding(
    prepared: PreparedWorkspace,
    plan: WorkspaceMutationPlan,
    context: Context,
  ): Promise<void> {
    const current = await this.#options.backend.currentBinding(prepared.conversationId, context);
    if (
      current === undefined ||
      !sameBinding(current, prepared.binding) ||
      current.writerEpoch !== plan.writerEpoch ||
      current.publishedCandidateKey !== (plan.previous?.candidateKey ?? null) ||
      !exactJson(generation(current.handle) as JsonValue, plan.workspace as JsonValue)
    ) {
      throw new Drive9ProtocolError("recovery_failed", "workspace binding changed during tool execution");
    }
  }

  #recoveryBackend(): WorkspaceRecoveryBackend {
    const backend = this.#options.backend;
    const tainted = this.#taintedLayers;
    return {
      currentBinding: async (conversationId, context) => {
        const current = await backend.currentBinding(conversationId, context);
        if (current === undefined || !tainted.has(current.handle.layerId)) return current;
        return { ...current, hasUnpublishedWrites: true };
      },
      forkFromCheckpoint: (input, context) => backend.forkFromCheckpoint(input, context),
      switchBinding: (input, context) => backend.switchBinding(input, context),
      abandon: (handle, context) => backend.abandon(handle, context),
    };
  }
}

export function createDrive9WorkspaceCoordinator(
  options: Drive9WorkspaceCoordinatorOptions,
): WorkspaceMutationCoordinator {
  return new Drive9WorkspaceCoordinator(options);
}
