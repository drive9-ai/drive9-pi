import { Drive9ProtocolError, protocolCause } from "../core/errors.js";
import { prefixedDigest } from "../core/identity.js";
import { requireServerFencedStorage, storageProfile } from "../storage/profile.js";
import { resolvePublishedWorkspace } from "./publication.js";
const MAX_DIRTY_RECOVERY_CHILDREN = 16;
function writerEpoch(input) {
    if (input.mode.kind === "stable")
        return requireServerFencedStorage(input.storage).writerEpoch;
    if (input.mode.writerEpoch.length === 0) {
        throw new Drive9ProtocolError("invalid_protocol_record", "preview writer epoch must be a non-empty string");
    }
    if (storageProfile(input.storage).kind === "server-fenced") {
        throw new Drive9ProtocolError("invalid_protocol_record", "server-fenced storage must use stable recovery mode");
    }
    return input.mode.writerEpoch;
}
function layerDepthLimit(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 16) {
        throw new Drive9ProtocolError("invalid_protocol_record", "LayerFS maximum depth must be a safe integer between 1 and 16");
    }
    return value;
}
function exactSource(binding, source, candidateKey) {
    return (binding.publishedCandidateKey === candidateKey &&
        binding.handle.sourceCheckpointId === source.checkpointId &&
        binding.handle.parentLayerId === source.layerId &&
        binding.handle.parentCheckpointId === source.checkpointId &&
        binding.handle.rootLayerId === source.rootLayerId &&
        binding.handle.depth === source.depth + 1);
}
function childIdentity(input) {
    return prefixedDigest("pir_", {
        protocol: "drive9.workspace-recovery/v1",
        conversationId: Number(input.conversationId),
        writerEpoch: input.writerEpoch,
        candidateKey: input.candidateKey,
        source: input.source,
        supersedesLayerId: input.supersedesLayerId,
    });
}
function verifyChild(handle, source) {
    if (handle.layerId === source.layerId ||
        handle.sourceCheckpointId !== source.checkpointId ||
        handle.parentLayerId !== source.layerId ||
        handle.parentCheckpointId !== source.checkpointId ||
        handle.rootLayerId !== source.rootLayerId ||
        handle.depth !== source.depth + 1) {
        throw new Drive9ProtocolError("checkpoint_mismatch", "recovery child lineage does not match the published checkpoint");
    }
}
async function abandonBestEffort(backend, handle, context, report) {
    if (handle === undefined)
        return;
    try {
        await backend.abandon(handle, context);
    }
    catch (error) {
        report?.(protocolCause(error));
    }
}
export async function recoverWorkspace(input) {
    const epoch = writerEpoch(input);
    const maxLayerDepth = layerDepthLimit(input.maxLayerDepth);
    const published = await resolvePublishedWorkspace({
        storage: input.storage,
        conversationId: input.conversationId,
        ...(input.cutoff === undefined ? {} : { cutoff: input.cutoff }),
        verifier: input.verifier,
        context: input.context,
    });
    if (published !== undefined) {
        if (input.expectedSessionId !== undefined &&
            published.data.sessionId !== input.expectedSessionId) {
            throw new Drive9ProtocolError("publication_breach", "published workspace belongs to another session");
        }
        if (published.data.checkpoint.rootLayerId !== input.initialCheckpoint.rootLayerId) {
            throw new Drive9ProtocolError("publication_breach", "published workspace has a different root lineage");
        }
    }
    const source = published?.data.checkpoint ?? input.initialCheckpoint;
    const candidateKey = published?.data.candidateKey ?? null;
    if (source.depth >= maxLayerDepth) {
        throw new Drive9ProtocolError("layer_depth_exhausted", `cannot recover checkpoint ${source.checkpointId}: LayerFS depth ${source.depth} has reached the configured limit ${maxLayerDepth}`);
    }
    const current = await input.backend.currentBinding(input.conversationId, input.context);
    if (current !== undefined && Number(current.conversationId) !== Number(input.conversationId)) {
        throw new Drive9ProtocolError("recovery_failed", "workspace binding belongs to a different conversation");
    }
    if (current !== undefined &&
        current.writerEpoch === epoch &&
        exactSource(current, source, candidateKey) &&
        !current.hasUnpublishedWrites) {
        return { published, binding: current };
    }
    let supersedes = current?.handle.layerId ?? null;
    let child;
    for (let attempt = 0; attempt < MAX_DIRTY_RECOVERY_CHILDREN; attempt += 1) {
        const forked = await input.backend.forkFromCheckpoint({
            source,
            childIdentity: childIdentity({
                conversationId: input.conversationId,
                writerEpoch: epoch,
                candidateKey,
                source,
                supersedesLayerId: supersedes,
            }),
            writerEpoch: epoch,
        }, input.context);
        verifyChild(forked.handle, source);
        if (forked.handle.layerId === current?.handle.layerId) {
            throw new Drive9ProtocolError("recovery_failed", "recovery did not create a fresh workspace generation");
        }
        if (!forked.hasUnpublishedWrites) {
            child = forked.handle;
            break;
        }
        await abandonBestEffort(input.backend, forked.handle, input.context, input.onAbandonError);
        supersedes = forked.handle.layerId;
    }
    if (child === undefined) {
        throw new Drive9ProtocolError("recovery_failed", "every reconciled recovery child contains unpublished writes");
    }
    try {
        await input.backend.switchBinding({
            conversationId: input.conversationId,
            writerEpoch: epoch,
            expectedLayerId: current?.handle.layerId ?? null,
            publishedCandidateKey: candidateKey,
            handle: child,
        }, input.context);
    }
    catch (error) {
        await abandonBestEffort(input.backend, child, input.context, input.onAbandonError);
        throw error;
    }
    if (current?.handle.layerId !== child.layerId) {
        await abandonBestEffort(input.backend, current?.handle, input.context, input.onAbandonError);
    }
    return {
        published,
        binding: {
            conversationId: input.conversationId,
            writerEpoch: epoch,
            publishedCandidateKey: candidateKey,
            handle: child,
            hasUnpublishedWrites: false,
        },
    };
}
//# sourceMappingURL=recovery.js.map