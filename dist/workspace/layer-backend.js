import { Drive9ProtocolError, protocolCause } from "../core/errors.js";
function requiredString(value, label) {
    const normalized = value.trim();
    if (normalized.length === 0) {
        throw new Drive9ProtocolError("checkpoint_mismatch", `${label} must be a non-empty string`);
    }
    return normalized;
}
function optionalString(value) {
    if (value === undefined)
        return null;
    const normalized = value.trim();
    return normalized.length === 0 ? null : normalized;
}
function safeInteger(value, label, maximum) {
    if (!Number.isSafeInteger(value) || value < 0 || (maximum !== undefined && value > maximum)) {
        throw new Drive9ProtocolError("checkpoint_mismatch", `${label} is outside the supported range`);
    }
    return value;
}
function lineage(layer) {
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
    }
    else if (parentCheckpointId === null || depth === 0) {
        throw new Drive9ProtocolError("checkpoint_mismatch", "forked layer is missing checkpoint lineage");
    }
    return { layerId, rootLayerId, parentLayerId, parentCheckpointId, depth };
}
function writableHandle(layer) {
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
function checkpoint(record, layer) {
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
function sameCheckpoint(left, right) {
    return (left.checkpointId === right.checkpointId &&
        left.durableSeq === right.durableSeq &&
        left.layerId === right.layerId &&
        left.rootLayerId === right.rootLayerId &&
        left.parentLayerId === right.parentLayerId &&
        left.parentCheckpointId === right.parentCheckpointId &&
        left.depth === right.depth);
}
function sameHandle(left, right) {
    return (left.layerId === right.layerId &&
        left.rootLayerId === right.rootLayerId &&
        left.parentLayerId === right.parentLayerId &&
        left.parentCheckpointId === right.parentCheckpointId &&
        left.sourceCheckpointId === right.sourceCheckpointId &&
        left.depth === right.depth &&
        left.executionEnvId === right.executionEnvId);
}
function sameBinding(left, right) {
    return (Number(left.conversationId) === Number(right.conversationId) &&
        left.writerEpoch === right.writerEpoch &&
        left.publishedCandidateKey === right.publishedCandidateKey &&
        sameHandle(left.handle, right.handle));
}
function throwIfAborted(context) {
    context.abortSignal?.throwIfAborted();
}
function conflict(error) {
    if (typeof error !== "object" || error === null)
        return false;
    const value = error;
    return value.statusCode === 409 || value.name === "ConflictError";
}
function recoveryFailure(message, error) {
    const cause = protocolCause(error);
    return new Drive9ProtocolError("recovery_failed", message, cause);
}
export class Drive9LayerWorkspaceBackend {
    #client;
    #bindings;
    constructor(options) {
        this.#client = options.client;
        this.#bindings = options.bindings;
    }
    async currentBinding(conversationId, context) {
        throwIfAborted(context);
        const stored = await this.#bindings.readBinding(conversationId, context);
        throwIfAborted(context);
        if (stored === undefined)
            return undefined;
        if (Number(stored.conversationId) !== Number(conversationId)) {
            throw new Drive9ProtocolError("recovery_failed", "workspace binding belongs to a different conversation");
        }
        let layer;
        try {
            layer = await this.#client.getFSLayer(stored.handle.layerId);
        }
        catch (error) {
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
    async forkFromCheckpoint(input, context) {
        throwIfAborted(context);
        const persistedSource = await this.#readCheckpoint(input.source.checkpointId, input.source.layerId, context);
        if (!sameCheckpoint(persistedSource, input.source)) {
            throw new Drive9ProtocolError("checkpoint_mismatch", "recovery source no longer matches its persisted lineage");
        }
        let layer;
        try {
            layer = await this.#client.forkFSLayer(input.source.layerId, {
                layer_id: input.childIdentity,
                checkpoint_id: input.source.checkpointId,
            });
        }
        catch (error) {
            if (!conflict(error))
                throw recoveryFailure("failed to fork the published LayerFS checkpoint", error);
            try {
                layer = await this.#client.getFSLayer(input.childIdentity);
            }
            catch (readError) {
                throw recoveryFailure("conflicting recovery child could not be reconciled", readError);
            }
        }
        throwIfAborted(context);
        const handle = writableHandle(layer);
        if (handle.layerId !== input.childIdentity ||
            handle.parentLayerId !== input.source.layerId ||
            handle.parentCheckpointId !== input.source.checkpointId ||
            handle.sourceCheckpointId !== input.source.checkpointId ||
            handle.rootLayerId !== input.source.rootLayerId ||
            handle.depth !== input.source.depth + 1) {
            throw new Drive9ProtocolError("checkpoint_mismatch", "recovery child does not match the requested lineage");
        }
        return {
            handle,
            hasUnpublishedWrites: await this.#hasUnpublishedWrites(layer, context),
        };
    }
    async switchBinding(input, context) {
        throwIfAborted(context);
        let receipt;
        try {
            receipt = await this.#bindings.compareAndSetBinding(input, context);
        }
        catch (error) {
            throw recoveryFailure("workspace binding compare-and-set failed", error);
        }
        throwIfAborted(context);
        const expected = {
            conversationId: input.conversationId,
            writerEpoch: input.writerEpoch,
            publishedCandidateKey: input.publishedCandidateKey,
            handle: input.handle,
        };
        if (receipt.previousLayerId !== input.expectedLayerId || !sameBinding(receipt.binding, expected)) {
            throw new Drive9ProtocolError("recovery_failed", "workspace binding compare-and-set receipt is inconsistent");
        }
    }
    async abandon(handle, context) {
        throwIfAborted(context);
        await this.#client.deleteFSLayer(handle.layerId, { cascade: false });
        throwIfAborted(context);
    }
    async checkpoint(input, context) {
        throwIfAborted(context);
        let created;
        try {
            created = await this.#client.checkpointFSLayer(input.handle.layerId, {
                checkpoint_id: input.checkpointId,
            });
        }
        catch (createError) {
            try {
                created = await this.#client.getFSLayerCheckpoint(input.checkpointId);
            }
            catch (readError) {
                throw new Drive9ProtocolError("candidate_commit_unknown", "LayerFS checkpoint creation outcome could not be reconciled", protocolCause(readError));
            }
            if (created.checkpoint_id !== input.checkpointId || created.layer_id !== input.handle.layerId) {
                throw new Drive9ProtocolError("checkpoint_mismatch", "reconciled checkpoint does not match the requested identity", protocolCause(createError));
            }
        }
        if (created.checkpoint_id !== input.checkpointId || created.layer_id !== input.handle.layerId) {
            throw new Drive9ProtocolError("checkpoint_mismatch", "created checkpoint does not match the requested identity");
        }
        let layer;
        try {
            layer = await this.#client.getFSLayer(input.handle.layerId);
        }
        catch (error) {
            throw recoveryFailure("failed to read the checkpointed LayerFS generation", error);
        }
        throwIfAborted(context);
        const verified = checkpoint(created, layer);
        if (!sameHandle(writableHandle(layer), input.handle)) {
            throw new Drive9ProtocolError("checkpoint_mismatch", "checkpointed layer no longer matches the prepared generation");
        }
        return verified;
    }
    async readCheckpoint(input, context) {
        return this.#readCheckpoint(input.checkpointId, input.layerId, context);
    }
    async verify(candidate, context) {
        return this.#readCheckpoint(candidate.checkpoint.checkpointId, candidate.checkpoint.layerId, context);
    }
    async #readCheckpoint(checkpointId, layerId, context) {
        throwIfAborted(context);
        let record;
        try {
            record = await this.#client.getFSLayerCheckpoint(checkpointId);
        }
        catch (error) {
            throw new Drive9ProtocolError("checkpoint_mismatch", "failed to read the LayerFS checkpoint", protocolCause(error));
        }
        throwIfAborted(context);
        if (record.checkpoint_id !== checkpointId || record.layer_id !== layerId) {
            throw new Drive9ProtocolError("checkpoint_mismatch", "LayerFS checkpoint identity does not match the request");
        }
        let layer;
        try {
            layer = await this.#client.getFSLayer(layerId);
        }
        catch (error) {
            throw new Drive9ProtocolError("checkpoint_mismatch", "failed to read the checkpoint layer", protocolCause(error));
        }
        throwIfAborted(context);
        return checkpoint(record, layer);
    }
    async #hasUnpublishedWrites(layer, context) {
        if (layer.state !== "active")
            return true;
        let events;
        try {
            events = await this.#client.listFSLayerEvents(layer.layer_id, 0);
        }
        catch (error) {
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
//# sourceMappingURL=layer-backend.js.map