import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FSLayerCheckpoint, FSLayerCheckpointRequest } from "drive9";
import {
  Drive9LayerWorkspaceRevisionProvider,
  type Drive9CheckpointClient,
} from "../src/workspace-revision.js";
import { ResultStoreError } from "../src/tool-result-types.js";

class FakeCheckpointClient implements Drive9CheckpointClient {
  readonly calls: Array<{ layerId: string; request: FSLayerCheckpointRequest }> = [];
  next: FSLayerCheckpoint = {
    checkpoint_id: "checkpoint-1",
    layer_id: "layer-1",
    durable_seq: 7,
    label: "demo",
    created_at: "2026-08-11T12:00:00Z",
  };

  async checkpointFSLayer(layerId: string, request: FSLayerCheckpointRequest): Promise<FSLayerCheckpoint> {
    this.calls.push({ layerId, request });
    return this.next;
  }
}

describe("Drive9LayerWorkspaceRevisionProvider", () => {
  it("checkpoints directly through the SDK and returns the exact durable binding", async () => {
    const client = new FakeCheckpointClient();
    const provider = new Drive9LayerWorkspaceRevisionProvider({
      client,
      layerId: "layer-1",
      checkpointLabel: "pi-demo",
      checkpointId: () => "fixed-checkpoint",
    });
    const revision = await provider.capture();
    assert.deepEqual(client.calls, [
      { layerId: "layer-1", request: { label: "pi-demo", checkpoint_id: "fixed-checkpoint" } },
    ]);
    assert.deepEqual(revision, {
      layerId: "layer-1",
      durableSeq: 7,
      snapshotId: "checkpoint-1",
      capturedAt: "2026-08-11T12:00:00.000Z",
    });
  });

  it("fails closed on a mismatched or malformed checkpoint", async () => {
    const client = new FakeCheckpointClient();
    client.next = { ...client.next, layer_id: "other-layer" };
    const provider = new Drive9LayerWorkspaceRevisionProvider({ client, layerId: "layer-1" });
    await assert.rejects(
      async () => await provider.capture(),
      (error: unknown) => error instanceof ResultStoreError && error.code === "corrupt",
    );
  });

  it("does not issue a checkpoint for a pre-aborted capture", async () => {
    const client = new FakeCheckpointClient();
    const provider = new Drive9LayerWorkspaceRevisionProvider({ client, layerId: "layer-1" });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      async () => await provider.capture(controller.signal),
      (error: unknown) => error instanceof ResultStoreError && error.code === "aborted",
    );
    assert.equal(client.calls.length, 0);
  });

  it("serializes concurrent SDK checkpoint captures", async () => {
    const client = new FakeCheckpointClient();
    let releaseFirst = (): void => {};
    const firstBarrier = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];
    client.checkpointFSLayer = async (layerId, request) => {
      const position = client.calls.length + 1;
      client.calls.push({ layerId, request });
      events.push(`checkpoint-${position}-start`);
      if (position === 1) await firstBarrier;
      events.push(`checkpoint-${position}-end`);
      return { ...client.next, checkpoint_id: `checkpoint-${position}` };
    };
    const provider = new Drive9LayerWorkspaceRevisionProvider({ client, layerId: "layer-1" });
    const first = provider.capture();
    const second = provider.capture();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["checkpoint-1-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(events, [
      "checkpoint-1-start",
      "checkpoint-1-end",
      "checkpoint-2-start",
      "checkpoint-2-end",
    ]);
  });
});
