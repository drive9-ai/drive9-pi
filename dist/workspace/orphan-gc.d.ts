import type { Context } from "@earendil-works/chord";
import type { Drive9LayerWorkspaceClient } from "./layer-backend.js";
import type { WorkspaceCandidateInventory } from "./orphans.js";
/**
 * Reference-aware orphan GC for abandoned LayerFS workspace layers.
 *
 * A candidate layer may be reclaimed ONLY when the inventory has already proven
 * it permanently unpublishable AND nothing else still references it. We never
 * reclaim by age or count, and we never cascade: a layer that still pins
 * descendants must survive. The reference check is built from the FULL layer
 * list (not the candidate inventory, which omits checkpoint-only and other
 * non-candidate layers that can still fork from a candidate), and the
 * server-side `still_pins`/409 on a non-cascading delete is the final arbiter
 * for any fork that races between enumeration and deletion.
 */
/** Why a reclaim decision came out the way it did (observable, for reporting). */
export type OrphanLayerReclaimOutcome = {
    readonly kind: "reclaimed";
} | {
    readonly kind: "skipped";
    readonly reason: "not-permanently-unpublishable" | "in-published-chain" | "has-descendant" | "layer-not-listed" | "still-referenced";
};
export type OrphanLayerReclaimResult = {
    readonly layerId: string;
    readonly candidateKey: string;
    readonly outcome: OrphanLayerReclaimOutcome;
};
export type ReclaimOrphanLayersInput = {
    readonly inventory: WorkspaceCandidateInventory;
    readonly client: Drive9LayerWorkspaceClient;
    readonly context: Context;
};
export type ReclaimOrphanLayersReport = {
    readonly reclaimedCount: number;
    readonly skippedCount: number;
    readonly results: readonly OrphanLayerReclaimResult[];
};
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
export declare function reclaimOrphanLayers(input: ReclaimOrphanLayersInput): Promise<ReclaimOrphanLayersReport>;
//# sourceMappingURL=orphan-gc.d.ts.map