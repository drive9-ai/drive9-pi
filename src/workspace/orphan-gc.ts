import type { Context } from "@earendil-works/chord";
import { Drive9ProtocolError, protocolCause } from "../core/errors.js";
import type { Drive9LayerRecord, Drive9LayerWorkspaceClient } from "./layer-backend.js";
import type { WorkspaceCandidateInventory, WorkspaceCandidateInventoryItem } from "./orphans.js";

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
export type OrphanLayerReclaimOutcome =
  | { readonly kind: "reclaimed" }
  | {
      readonly kind: "skipped";
      readonly reason:
        | "not-permanently-unpublishable"
        | "in-published-chain"
        | "has-descendant"
        | "layer-not-listed"
        | "still-referenced"; // server rejected the non-cascading delete (still_pins/409)
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

function isConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { readonly name?: unknown; readonly statusCode?: unknown };
  return value.statusCode === 409 || value.name === "ConflictError";
}

/**
 * Build the set of layer ids that are referenced as a parent by any live layer.
 * A layer with a nonempty `state` that is NOT a terminal tombstone still counts
 * as a reference; we deliberately keep this conservative — any layer row naming
 * our candidate as its parent blocks reclamation, so a stale or unexpected
 * child errs toward retention, never toward deletion.
 */
function referencedParentIds(layers: readonly Drive9LayerRecord[]): ReadonlySet<string> {
  const referenced = new Set<string>();
  for (const layer of layers) {
    const parent = layer.parent_layer_id;
    if (parent !== undefined && parent.length > 0) referenced.add(parent);
  }
  return referenced;
}

function reclaimableCandidates(
  inventory: WorkspaceCandidateInventory,
): readonly WorkspaceCandidateInventoryItem[] {
  return inventory.items.filter((item) => item.disposition.kind === "permanently-unpublishable");
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
export async function reclaimOrphanLayers(
  input: ReclaimOrphanLayersInput,
): Promise<ReclaimOrphanLayersReport> {
  const candidates = reclaimableCandidates(input.inventory);
  if (candidates.length === 0) {
    return { reclaimedCount: 0, skippedCount: 0, results: [] };
  }

  let layers: Drive9LayerRecord[];
  try {
    layers = await input.client.listFSLayers();
  } catch (error) {
    throw new Drive9ProtocolError(
      "recovery_failed",
      "orphan GC cannot enumerate layers to prove reference safety",
      protocolCause(error),
    );
  }

  const listedLayerIds = new Set(layers.map((layer) => layer.layer_id));
  const referenced = referencedParentIds(layers);
  const publishedKey = input.inventory.publishedCandidateKey;

  const results: OrphanLayerReclaimResult[] = [];
  for (const candidate of candidates) {
    const base = { layerId: candidate.layerId, candidateKey: candidate.candidateKey };

    // Never touch the currently published candidate, even if some disposition
    // race classified it unpublishable: the published pointer is authoritative.
    if (publishedKey !== null && candidate.candidateKey === publishedKey) {
      results.push({ ...base, outcome: { kind: "skipped", reason: "in-published-chain" } });
      continue;
    }
    // A layer that is not in the authoritative listing cannot be proven
    // unreferenced (it may be invisible to this credential yet forked from),
    // so retain it rather than delete blind.
    if (!listedLayerIds.has(candidate.layerId)) {
      results.push({ ...base, outcome: { kind: "skipped", reason: "layer-not-listed" } });
      continue;
    }
    if (referenced.has(candidate.layerId)) {
      results.push({ ...base, outcome: { kind: "skipped", reason: "has-descendant" } });
      continue;
    }

    try {
      await input.client.deleteFSLayer(candidate.layerId, { cascade: false });
      results.push({ ...base, outcome: { kind: "reclaimed" } });
    } catch (error) {
      if (isConflict(error)) {
        // A fork committed between enumeration and deletion: the server still
        // pins this layer. Honor that — skip, do not cascade.
        results.push({ ...base, outcome: { kind: "skipped", reason: "still-referenced" } });
        continue;
      }
      throw new Drive9ProtocolError(
        "recovery_failed",
        `orphan GC failed to delete layer ${candidate.layerId}`,
        protocolCause(error),
      );
    }
  }

  const reclaimedCount = results.filter((result) => result.outcome.kind === "reclaimed").length;
  return {
    reclaimedCount,
    skippedCount: results.length - reclaimedCount,
    results,
  };
}
