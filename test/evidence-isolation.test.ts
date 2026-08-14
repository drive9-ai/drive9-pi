import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  verifyEvidenceIsolation,
  type EvidenceProbeClient,
} from "../src/evidence-isolation.js";
import { ResultStoreError } from "../src/tool-result-types.js";

class ProbeStatusError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number) {
    super(`status ${statusCode}`);
    this.statusCode = statusCode;
  }
}

class ProbeClient implements EvidenceProbeClient {
  readonly objects = new Map<string, { data: Uint8Array; revision: number }>();
  readonly deny: boolean;

  constructor(deny = false) {
    this.deny = deny;
  }

  async writeWithRevision(
    path: string,
    data: Uint8Array,
    options: { expectedRevision: number },
  ): Promise<number> {
    if (this.deny) throw new ProbeStatusError(403);
    const current = this.objects.get(path);
    if (options.expectedRevision === 0) {
      if (current !== undefined) throw new ProbeStatusError(409);
      this.objects.set(path, { data: Uint8Array.from(data), revision: 1 });
      return 1;
    }
    if (current === undefined) throw new ProbeStatusError(404);
    if (current.revision !== options.expectedRevision) throw new ProbeStatusError(409);
    const revision = current.revision + 1;
    this.objects.set(path, { data: Uint8Array.from(data), revision });
    return revision;
  }

  async read(path: string): Promise<Uint8Array> {
    if (this.deny) throw new ProbeStatusError(403);
    const current = this.objects.get(path);
    if (current === undefined) throw new ProbeStatusError(404);
    return Uint8Array.from(current.data);
  }

  async delete(path: string): Promise<void> {
    if (this.deny) throw new ProbeStatusError(403);
    this.objects.delete(path);
  }

  async mkdir(): Promise<void> {}
}

describe("verifyEvidenceIsolation", () => {
  it("proves evidence authority while the workspace authority is denied", async () => {
    const receipt = await verifyEvidenceIsolation({
      workspaceRemoteRoot: "/workspaces/run",
      evidenceRemoteRoot: "/evidence/run",
      workspaceClient: new ProbeClient(true),
      evidenceClient: new ProbeClient(),
    });
    assert.deepEqual(
      { ...receipt, verifiedAt: "timestamp" },
      {
        workspaceRootVerified: true,
        rootsDisjoint: true,
        evidenceCreateReadReplaceDelete: true,
        workspaceReadDenied: true,
        workspaceWriteDenied: true,
        workspaceDeleteDenied: true,
        verifiedAt: "timestamp",
      },
    );
    assert.ok(Number.isFinite(Date.parse(receipt.verifiedAt)));
  });

  it("rejects overlapping roots before probing", async () => {
    const evidenceClient = new ProbeClient();
    await assert.rejects(
      async () =>
        await verifyEvidenceIsolation({
          workspaceRemoteRoot: "/workspaces/run",
          evidenceRemoteRoot: "/workspaces/run/evidence",
          workspaceClient: new ProbeClient(true),
          evidenceClient,
        }),
      (error: unknown) => error instanceof ResultStoreError && error.code === "invalid",
    );
    assert.equal(evidenceClient.objects.size, 0);
  });

  it("fails closed when the workspace credential can access evidence", async () => {
    const shared = new ProbeClient();
    await assert.rejects(
      async () =>
        await verifyEvidenceIsolation({
          workspaceRemoteRoot: "/workspaces/run",
          evidenceRemoteRoot: "/evidence/run",
          workspaceClient: shared,
          evidenceClient: shared,
        }),
      (error: unknown) => error instanceof ResultStoreError && error.code === "permission_denied",
    );
    assert.equal(shared.objects.size, 0);
  });

  it("does not treat missing or generic failures as authorization denial", async () => {
    const missingClient = new ProbeClient(true);
    missingClient.read = async () => {
      throw new ProbeStatusError(404);
    };
    await assert.rejects(
      async () =>
        await verifyEvidenceIsolation({
          workspaceRemoteRoot: "/workspaces/run",
          evidenceRemoteRoot: "/evidence/run",
          workspaceClient: missingClient,
          evidenceClient: new ProbeClient(),
        }),
      (error: unknown) => error instanceof ResultStoreError && error.code === "permission_denied",
    );
  });
});
