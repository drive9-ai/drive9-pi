import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FSLayerCheckpoint, FSLayerCheckpointRequest } from "drive9";
import {
  Drive9LayerWorkspaceRevisionProvider,
  selectDrive9MountDrainEnvironment,
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
  it("does not forward host credentials or configuration discovery paths to mount drain", () => {
    const previous = {
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      DRIVE9_API_KEY: process.env.DRIVE9_API_KEY,
      DRIVE9_SERVER: process.env.DRIVE9_SERVER,
    };
    process.env.HOME = "/host-home-sentinel";
    process.env.XDG_CONFIG_HOME = "/host-xdg-sentinel";
    process.env.DRIVE9_API_KEY = "host-api-key-sentinel";
    process.env.DRIVE9_SERVER = "host-server-sentinel";
    try {
      const selected = selectDrive9MountDrainEnvironment(undefined);
      assert.equal(selected.HOME, undefined);
      assert.equal(selected.XDG_CONFIG_HOME, undefined);
      assert.equal(selected.DRIVE9_API_KEY, undefined);
      assert.equal(selected.DRIVE9_SERVER, undefined);
      assert.equal(selected.PATH, process.env.PATH);
      assert.equal(selected.TMPDIR, process.env.TMPDIR);
      assert.equal(selected.XDG_RUNTIME_DIR, process.env.XDG_RUNTIME_DIR);
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("drains before checkpoint and returns the exact durable binding", async () => {
    const client = new FakeCheckpointClient();
    const order: string[] = [];
    client.checkpointFSLayer = async (layerId, request) => {
      order.push("checkpoint");
      client.calls.push({ layerId, request });
      return client.next;
    };
    const provider = new Drive9LayerWorkspaceRevisionProvider({
      client,
      layerId: "layer-1",
      checkpointLabel: "pi-demo",
      checkpointId: () => "fixed-checkpoint",
      drain: async () => {
        order.push("drain");
      },
    });
    const revision = await provider.capture();
    assert.deepEqual(order, ["drain", "checkpoint"]);
    assert.deepEqual(client.calls, [
      {
        layerId: "layer-1",
        request: { label: "pi-demo", checkpoint_id: "fixed-checkpoint" },
      },
    ]);
    assert.deepEqual(revision, {
      layerId: "layer-1",
      durableSeq: 7,
      snapshotId: "checkpoint-1",
      capturedAt: "2026-08-11T12:00:00.000Z",
    });
  });

  it("does not checkpoint after a failed drain", async () => {
    const client = new FakeCheckpointClient();
    const provider = new Drive9LayerWorkspaceRevisionProvider({
      client,
      layerId: "layer-1",
      drain: async () => {
        throw new Error("dirty writes remain");
      },
    });
    await assert.rejects(
      async () => await provider.capture(),
      (error: unknown) => error instanceof ResultStoreError && error.code === "unavailable",
    );
    assert.equal(client.calls.length, 0);
  });

  it("fails closed on a mismatched or malformed checkpoint", async () => {
    const client = new FakeCheckpointClient();
    client.next = { ...client.next, layer_id: "other-layer" };
    const provider = new Drive9LayerWorkspaceRevisionProvider({
      client,
      layerId: "layer-1",
      drain: async () => {},
    });
    await assert.rejects(
      async () => await provider.capture(),
      (error: unknown) => error instanceof ResultStoreError && error.code === "corrupt",
    );
  });

  it("serializes concurrent drain/checkpoint captures", async () => {
    const client = new FakeCheckpointClient();
    let releaseFirst = (): void => {};
    const firstBarrier = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];
    let drains = 0;
    const provider = new Drive9LayerWorkspaceRevisionProvider({
      client,
      layerId: "layer-1",
      drain: async () => {
        drains += 1;
        events.push(`drain-${drains}-start`);
        if (drains === 1) await firstBarrier;
        events.push(`drain-${drains}-end`);
      },
    });
    client.checkpointFSLayer = async () => {
      events.push(`checkpoint-${client.calls.length + 1}`);
      client.calls.push({ layerId: "layer-1", request: {} });
      return { ...client.next, checkpoint_id: `checkpoint-${client.calls.length}` };
    };
    const first = provider.capture();
    const second = provider.capture();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["drain-1-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(events, [
      "drain-1-start",
      "drain-1-end",
      "checkpoint-1",
      "drain-2-start",
      "drain-2-end",
      "checkpoint-2",
    ]);
  });
});
