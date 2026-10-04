import { Drive9ProtocolError, protocolCause } from "../core/errors.js";
function isConflict(error) {
    if (typeof error !== "object" || error === null)
        return false;
    const value = error;
    return value.statusCode === 409 || value.name === "ConflictError";
}
/**
 * Build the set of layer ids that are referenced as a parent by any live layer.
 * A layer with a nonempty `state` that is NOT a terminal tombstone still counts
 * as a reference; we deliberately keep this conservative — any layer row naming
 * our candidate as its parent blocks reclamation, so a stale or unexpected
 * child errs toward retention, never toward deletion.
 */
function referencedParentIds(layers) {
    const referenced = new Set();
    for (const layer of layers) {
        const parent = layer.parent_layer_id;
        if (parent !== undefined && parent.length > 0)
            referenced.add(parent);
    }
    return referenced;
}
/**
 * Group inventory items by their physical `layerId`. Eligibility and deletion
 * are layer-level, not item-level: several candidate records can share one
 * layer, and a layer is only reclaimable when EVERY item backing it is
 * permanently unpublishable. Grouping keeps the (possibly duplicated) item
 * order so a layer is examined once and deleted at most once.
 */
function groupByLayer(inventory) {
    const groups = new Map();
    for (const item of inventory.items) {
        const existing = groups.get(item.layerId);
        if (existing === undefined) {
            groups.set(item.layerId, {
                layerId: item.layerId,
                candidateKeys: [item.candidateKey],
                items: [item],
            });
            continue;
        }
        existing.candidateKeys.push(item.candidateKey);
        existing.items.push(item);
    }
    return [...groups.values()];
}
/**
 * Reclaim permanently-unpublishable orphan layers that nothing else references.
 *
 * Fail-closed guarantees:
 * - If the full layer listing cannot be fetched, the whole pass aborts with a
 *   protocol error: without the reference index we cannot prove safety, so we
 *   reclaim nothing.
 * - A candidate whose layer still has any descendant (direct child in the layer
 *   list) is skipped, never deleted.
 * - Deletion is always non-cascading. A server `still_pins`/409 — a fork that
 *   committed between enumeration and deletion — is treated as "still
 *   referenced" and skipped, NEVER retried as a cascading delete.
 * - Any other deletion error aborts the pass (the layer is left intact and the
 *   error surfaces), so a transient backend fault never silently drops work or
 *   marks a layer reclaimed that was not deleted.
 */
export async function reclaimOrphanLayers(input) {
    const groups = groupByLayer(input.inventory);
    // A layer is a candidate for reclamation only when EVERY item backing it is
    // permanently unpublishable. A single published/unresolved item on the same
    // physical layer makes deleting it unsafe, so such groups are not eligible.
    const eligible = groups.filter((group) => group.items.every((item) => item.disposition.kind === "permanently-unpublishable"));
    // Groups that mix dispositions on one layer are reported as skipped so the
    // outcome is observable rather than silently ignored.
    const mixed = groups.filter((group) => group.items.some((item) => item.disposition.kind === "permanently-unpublishable") &&
        group.items.some((item) => item.disposition.kind !== "permanently-unpublishable"));
    if (eligible.length === 0 && mixed.length === 0) {
        return { reclaimedCount: 0, skippedCount: 0, results: [] };
    }
    const results = mixed.map((group) => ({
        layerId: group.layerId,
        candidateKeys: group.candidateKeys,
        outcome: { kind: "skipped", reason: "mixed-disposition" },
    }));
    if (eligible.length === 0) {
        return { reclaimedCount: 0, skippedCount: results.length, results };
    }
    let layers;
    try {
        layers = await input.client.listFSLayers();
    }
    catch (error) {
        throw new Drive9ProtocolError("recovery_failed", "orphan GC cannot enumerate layers to prove reference safety", protocolCause(error));
    }
    const listedLayerIds = new Set(layers.map((layer) => layer.layer_id));
    const referenced = referencedParentIds(layers);
    const publishedKey = input.inventory.publishedCandidateKey;
    for (const group of eligible) {
        const base = { layerId: group.layerId, candidateKeys: group.candidateKeys };
        // Never touch a layer that backs the currently published candidate, even if
        // a disposition race classified its records unpublishable: the published
        // pointer is authoritative.
        if (publishedKey !== null && group.candidateKeys.includes(publishedKey)) {
            results.push({ ...base, outcome: { kind: "skipped", reason: "in-published-chain" } });
            continue;
        }
        // A layer that is not in the authoritative listing cannot be proven
        // unreferenced (it may be invisible to this credential yet forked from),
        // so retain it rather than delete blind.
        if (!listedLayerIds.has(group.layerId)) {
            results.push({ ...base, outcome: { kind: "skipped", reason: "layer-not-listed" } });
            continue;
        }
        if (referenced.has(group.layerId)) {
            results.push({ ...base, outcome: { kind: "skipped", reason: "has-descendant" } });
            continue;
        }
        try {
            // One physical delete per unique layer, regardless of how many candidate
            // records referenced it.
            await input.client.deleteFSLayer(group.layerId, { cascade: false });
            results.push({ ...base, outcome: { kind: "reclaimed" } });
        }
        catch (error) {
            if (isConflict(error)) {
                // A fork committed between enumeration and deletion: the server still
                // pins this layer. Honor that — skip, do not cascade.
                results.push({ ...base, outcome: { kind: "skipped", reason: "still-referenced" } });
                continue;
            }
            throw new Drive9ProtocolError("recovery_failed", `orphan GC failed to delete layer ${group.layerId}`, protocolCause(error));
        }
    }
    const reclaimedCount = results.filter((result) => result.outcome.kind === "reclaimed").length;
    return {
        reclaimedCount,
        skippedCount: results.length - reclaimedCount,
        results,
    };
}
//# sourceMappingURL=orphan-gc.js.map