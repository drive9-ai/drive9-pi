import { Drive9ProtocolError } from "../core/errors.js";
import { canonicalJson } from "../core/identity.js";
import { requireServerFencedStorage } from "../storage/profile.js";
import { buildWorkspaceAttemptData, deriveWorkspaceCandidateKey } from "./entries.js";
import { recoverWorkspace, } from "./recovery.js";
function exactJson(left, right) {
    return canonicalJson(left) === canonicalJson(right);
}
function exactCheckpoint(left, right) {
    return exactJson(left, right);
}
function generation(handle) {
    return {
        layerId: handle.layerId,
        rootLayerId: handle.rootLayerId,
        parentLayerId: handle.parentLayerId,
        parentCheckpointId: handle.parentCheckpointId,
        depth: handle.depth,
        executionEnvId: handle.executionEnvId,
    };
}
function publishedRef(candidate) {
    if (candidate === undefined)
        return null;
    return {
        candidateKey: candidate.data.candidateKey,
        checkpointId: candidate.data.checkpoint.checkpointId,
        durableSeq: candidate.data.checkpoint.durableSeq,
        layerId: candidate.data.checkpoint.layerId,
        rootLayerId: candidate.data.checkpoint.rootLayerId,
        depth: candidate.data.checkpoint.depth,
    };
}
function expectedCheckpoint(checkpoint, checkpointId, workspace) {
    return (checkpoint.checkpointId === checkpointId &&
        checkpoint.layerId === workspace.layerId &&
        checkpoint.rootLayerId === workspace.rootLayerId &&
        checkpoint.parentLayerId === workspace.parentLayerId &&
        checkpoint.parentCheckpointId === workspace.parentCheckpointId &&
        checkpoint.depth === workspace.depth);
}
function sameBinding(left, right) {
    return (Number(left.conversationId) === Number(right.conversationId) &&
        left.writerEpoch === right.writerEpoch &&
        left.publishedCandidateKey === right.publishedCandidateKey &&
        exactJson(left.handle, right.handle));
}
export class Drive9WorkspaceCoordinator {
    #options;
    #prepared = new WeakMap();
    #taintedLayers = new Set();
    #poisoned;
    constructor(options) {
        if (options.sessionId.length === 0) {
            throw new Drive9ProtocolError("invalid_protocol_record", "session ID must be a non-empty string");
        }
        this.#options = options;
    }
    async prepare(input, context) {
        this.#assertUsable();
        const initial = await this.#options.initialCheckpoint(input.conversationId, context);
        const verifiedInitial = await this.#options.backend.readCheckpoint({ checkpointId: initial.checkpointId, layerId: initial.layerId }, context);
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
            throw new Drive9ProtocolError("execution_env_mismatch", "Pi tools and shell must use the recovered Drive9 workspace namespace");
        }
        const plan = {
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
    async checkpointAndVerify(request, context) {
        this.#assertUsable();
        const prepared = this.#prepared.get(request.plan);
        if (prepared === undefined ||
            Number(prepared.conversationId) !== Number(request.conversationId) ||
            prepared.taskId !== Number(request.taskId) ||
            prepared.toolCallId !== request.toolCallId ||
            prepared.effect !== request.effect) {
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
        const created = await this.#options.backend.checkpoint({
            handle: prepared.binding.handle,
            checkpointId: request.checkpointId,
            writerEpoch: request.plan.writerEpoch,
            previous: request.plan.previous,
        }, context);
        if (!expectedCheckpoint(created, request.checkpointId, request.plan.workspace)) {
            throw new Drive9ProtocolError("checkpoint_mismatch", "created checkpoint does not match the prepared workspace");
        }
        const verified = await this.#options.backend.readCheckpoint({ checkpointId: request.checkpointId, layerId: request.plan.workspace.layerId }, context);
        if (!exactCheckpoint(created, verified)) {
            throw new Drive9ProtocolError("checkpoint_mismatch", "checkpoint create and independent read disagree");
        }
        await this.#assertCurrentBinding(prepared, request.plan, context);
        return verified;
    }
    invalidate(plan) {
        const prepared = this.#prepared.get(plan);
        if (prepared !== undefined)
            this.#taintedLayers.add(prepared.binding.handle.layerId);
    }
    async poison(error, context) {
        const poison = error instanceof Drive9ProtocolError
            ? error
            : new Drive9ProtocolError("session_poisoned", "Drive9 workspace session is poisoned", error);
        this.#poisoned ??= poison;
        try {
            await this.#options.onPoison?.(this.#poisoned, context);
        }
        finally {
            throw this.#poisoned;
        }
    }
    #assertUsable() {
        if (this.#poisoned !== undefined) {
            throw new Drive9ProtocolError("session_poisoned", "Drive9 workspace session cannot continue after an unknown publication outcome", this.#poisoned);
        }
    }
    #assertWriterEpoch(expected) {
        const actual = this.#options.mode.kind === "stable"
            ? requireServerFencedStorage(this.#options.storage).writerEpoch
            : this.#options.mode.writerEpoch;
        if (actual !== expected) {
            throw new Drive9ProtocolError("recovery_failed", "workspace writer epoch changed during tool execution");
        }
    }
    async #assertCurrentBinding(prepared, plan, context) {
        const current = await this.#options.backend.currentBinding(prepared.conversationId, context);
        if (current === undefined ||
            !sameBinding(current, prepared.binding) ||
            current.writerEpoch !== plan.writerEpoch ||
            current.publishedCandidateKey !== (plan.previous?.candidateKey ?? null) ||
            !exactJson(generation(current.handle), plan.workspace)) {
            throw new Drive9ProtocolError("recovery_failed", "workspace binding changed during tool execution");
        }
    }
    #recoveryBackend() {
        const backend = this.#options.backend;
        const tainted = this.#taintedLayers;
        return {
            currentBinding: async (conversationId, context) => {
                const current = await backend.currentBinding(conversationId, context);
                if (current === undefined || !tainted.has(current.handle.layerId))
                    return current;
                return { ...current, hasUnpublishedWrites: true };
            },
            forkFromCheckpoint: (input, context) => backend.forkFromCheckpoint(input, context),
            switchBinding: (input, context) => backend.switchBinding(input, context),
            abandon: (handle, context) => backend.abandon(handle, context),
        };
    }
}
export function createDrive9WorkspaceCoordinator(options) {
    return new Drive9WorkspaceCoordinator(options);
}
//# sourceMappingURL=coordinator.js.map