import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  verifyRuntimeIsolation,
  type RuntimeIsolationProbeClient,
} from "../src/runtime-isolation.js";
import { ResultStoreError } from "../src/tool-result-types.js";

class ProbeStatusError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number) {
    super(`status ${statusCode}`);
    this.statusCode = statusCode;
  }
}

class ObjectStore {
  readonly objects = new Map<string, { data: Uint8Array; revision: number }>();
}

class ScopedProbeClient implements RuntimeIsolationProbeClient {
  constructor(
    private readonly store: ObjectStore,
    private readonly readRoots: readonly string[],
    private readonly writeRoots: readonly string[],
    private readonly deleteRoots: readonly string[] = writeRoots,
  ) {}

  async writeWithRevision(
    path: string,
    data: Uint8Array,
    options: { expectedRevision: number },
  ): Promise<number> {
    this.requireRoot(path, this.writeRoots);
    const current = this.store.objects.get(path);
    if (options.expectedRevision === 0) {
      if (current !== undefined) throw new ProbeStatusError(409);
      this.store.objects.set(path, { data: Uint8Array.from(data), revision: 1 });
      return 1;
    }
    if (current === undefined) throw new ProbeStatusError(404);
    if (current.revision !== options.expectedRevision) throw new ProbeStatusError(409);
    const revision = current.revision + 1;
    this.store.objects.set(path, { data: Uint8Array.from(data), revision });
    return revision;
  }

  async read(path: string): Promise<Uint8Array> {
    this.requireRoot(path, this.readRoots);
    const current = this.store.objects.get(path);
    if (current === undefined) throw new ProbeStatusError(404);
    return Uint8Array.from(current.data);
  }

  async delete(path: string): Promise<void> {
    this.requireRoot(path, this.deleteRoots);
    if (!this.store.objects.delete(path)) throw new ProbeStatusError(404);
  }

  async mkdir(path: string): Promise<void> {
    this.requireRoot(path, this.writeRoots);
  }

  private requireRoot(path: string, roots: readonly string[]): void {
    if (!roots.some((root) => path === root || path.startsWith(`${root}/`))) {
      throw new ProbeStatusError(403);
    }
  }
}

function isolatedClients(workspaceEvidenceRead: "allow" | "deny" = "deny") {
  const store = new ObjectStore();
  return {
    store,
    workspaceClient: new ScopedProbeClient(
      store,
      workspaceEvidenceRead === "allow" ? ["/workspaces/run", "/evidence/run"] : ["/workspaces/run"],
      ["/workspaces/run"],
    ),
    stateClient: new ScopedProbeClient(store, ["/state/run"], ["/state/run"]),
    evidenceClient: new ScopedProbeClient(store, ["/evidence/run"], ["/evidence/run"]),
  };
}

describe("verifyRuntimeIsolation", () => {
  it("proves three disjoint authorities with workspace evidence reads denied", async () => {
    const clients = isolatedClients();
    const receipt = await verifyRuntimeIsolation({
      workspaceRemoteRoot: "/workspaces/run",
      stateRemoteRoot: "/state/run",
      evidenceRemoteRoot: "/evidence/run",
      workspaceEvidenceRead: "deny",
      ...clients,
    });
    assert.deepEqual(
      { ...receipt, verifiedAt: "timestamp" },
      {
        rootsDisjoint: true,
        workspaceCreateReadReplaceDelete: true,
        stateCreateReadReplaceDelete: true,
        evidenceCreateReadReplaceDelete: true,
        workspaceStateReadDenied: true,
        workspaceStateWriteDenied: true,
        workspaceStateDeleteDenied: true,
        workspaceEvidenceRead: "denied",
        workspaceEvidenceWriteDenied: true,
        workspaceEvidenceDeleteDenied: true,
        stateWorkspaceWriteDenied: true,
        stateWorkspaceDeleteDenied: true,
        evidenceStateWriteDenied: true,
        evidenceStateDeleteDenied: true,
        verifiedAt: "timestamp",
      },
    );
    assert.ok(Number.isFinite(Date.parse(receipt.verifiedAt)));
    assert.equal(clients.store.objects.size, 0);
  });

  it("requires an explicit read-only workspace evidence policy", async () => {
    const clients = isolatedClients("allow");
    const receipt = await verifyRuntimeIsolation({
      workspaceRemoteRoot: "/workspaces/run",
      stateRemoteRoot: "/state/run",
      evidenceRemoteRoot: "/evidence/run",
      workspaceEvidenceRead: "allow",
      ...clients,
    });
    assert.equal(receipt.workspaceEvidenceRead, "allowed");
    assert.equal(clients.store.objects.size, 0);
  });

  it("rejects an invalid workspace evidence policy before probing", async () => {
    const clients = isolatedClients();
    await assert.rejects(
      async () =>
        await verifyRuntimeIsolation({
          workspaceRemoteRoot: "/workspaces/run",
          stateRemoteRoot: "/state/run",
          evidenceRemoteRoot: "/evidence/run",
          workspaceEvidenceRead: "implicit" as "deny",
          ...clients,
        }),
      (error: unknown) => error instanceof ResultStoreError && error.code === "invalid",
    );
    assert.equal(clients.store.objects.size, 0);
  });

  it("rejects every overlapping pair before probing", async () => {
    for (const roots of [
      ["/runtime", "/runtime/state", "/evidence"],
      ["/workspace", "/runtime", "/runtime/evidence"],
      ["/runtime/workspace", "/state", "/runtime"],
    ] as const) {
      const clients = isolatedClients();
      await assert.rejects(
        async () =>
          await verifyRuntimeIsolation({
            workspaceRemoteRoot: roots[0],
            stateRemoteRoot: roots[1],
            evidenceRemoteRoot: roots[2],
            workspaceEvidenceRead: "deny",
            ...clients,
          }),
        (error: unknown) => error instanceof ResultStoreError && error.code === "invalid",
      );
      assert.equal(clients.store.objects.size, 0);
    }
  });

  it("normalizes roots and rejects URL-ambiguous roots before probing", async () => {
    const clients = isolatedClients();
    await assert.rejects(
      async () =>
        await verifyRuntimeIsolation({
          workspaceRemoteRoot: "/workspa\u0301ces/run",
          stateRemoteRoot: "/worksp\u00e1ces/run/state",
          evidenceRemoteRoot: "/evidence/run",
          workspaceEvidenceRead: "deny",
          ...clients,
        }),
      (error: unknown) => error instanceof ResultStoreError && error.code === "invalid",
    );

    for (const root of ["/state/%2e%2e/private", "/state?query", "/state#fragment", "/state/\ud800"]) {
      await assert.rejects(
        async () =>
          await verifyRuntimeIsolation({
            workspaceRemoteRoot: "/workspaces/run",
            stateRemoteRoot: root,
            evidenceRemoteRoot: "/evidence/run",
            workspaceEvidenceRead: "deny",
            ...clients,
          }),
        (error: unknown) => error instanceof ResultStoreError && error.code === "invalid",
      );
    }
    assert.equal(clients.store.objects.size, 0);
  });

  it("fails closed for every forbidden cross-authority operation", async () => {
    const cases = [
      {
        name: "workspace reads state",
        clients: (clients: ReturnType<typeof isolatedClients>) => ({
          workspaceClient: new ScopedProbeClient(
            clients.store,
            ["/workspaces/run", "/state/run"],
            ["/workspaces/run"],
          ),
        }),
      },
      {
        name: "workspace writes state",
        clients: (clients: ReturnType<typeof isolatedClients>) => ({
          workspaceClient: new ScopedProbeClient(
            clients.store,
            ["/workspaces/run"],
            ["/workspaces/run", "/state/run"],
            ["/workspaces/run"],
          ),
        }),
      },
      {
        name: "workspace deletes state",
        clients: (clients: ReturnType<typeof isolatedClients>) => ({
          workspaceClient: new ScopedProbeClient(
            clients.store,
            ["/workspaces/run"],
            ["/workspaces/run"],
            ["/workspaces/run", "/state/run"],
          ),
        }),
      },
      {
        name: "workspace reads evidence without permission",
        clients: (clients: ReturnType<typeof isolatedClients>) => ({
          workspaceClient: new ScopedProbeClient(
            clients.store,
            ["/workspaces/run", "/evidence/run"],
            ["/workspaces/run"],
          ),
        }),
      },
      {
        name: "workspace writes evidence",
        clients: (clients: ReturnType<typeof isolatedClients>) => ({
          workspaceClient: new ScopedProbeClient(
            clients.store,
            ["/workspaces/run"],
            ["/workspaces/run", "/evidence/run"],
            ["/workspaces/run"],
          ),
        }),
      },
      {
        name: "workspace deletes evidence",
        clients: (clients: ReturnType<typeof isolatedClients>) => ({
          workspaceClient: new ScopedProbeClient(
            clients.store,
            ["/workspaces/run"],
            ["/workspaces/run"],
            ["/workspaces/run", "/evidence/run"],
          ),
        }),
      },
      {
        name: "state writes workspace",
        clients: (clients: ReturnType<typeof isolatedClients>) => ({
          stateClient: new ScopedProbeClient(
            clients.store,
            ["/state/run"],
            ["/state/run", "/workspaces/run"],
            ["/state/run"],
          ),
        }),
      },
      {
        name: "state deletes workspace",
        clients: (clients: ReturnType<typeof isolatedClients>) => ({
          stateClient: new ScopedProbeClient(
            clients.store,
            ["/state/run"],
            ["/state/run"],
            ["/state/run", "/workspaces/run"],
          ),
        }),
      },
      {
        name: "evidence writes state",
        clients: (clients: ReturnType<typeof isolatedClients>) => ({
          evidenceClient: new ScopedProbeClient(
            clients.store,
            ["/evidence/run"],
            ["/evidence/run", "/state/run"],
            ["/evidence/run"],
          ),
        }),
      },
      {
        name: "evidence deletes state",
        clients: (clients: ReturnType<typeof isolatedClients>) => ({
          evidenceClient: new ScopedProbeClient(
            clients.store,
            ["/evidence/run"],
            ["/evidence/run"],
            ["/evidence/run", "/state/run"],
          ),
        }),
      },
    ] as const;

    for (const testCase of cases) {
      const clients = isolatedClients();
      await assert.rejects(
        async () =>
          await verifyRuntimeIsolation({
            workspaceRemoteRoot: "/workspaces/run",
            stateRemoteRoot: "/state/run",
            evidenceRemoteRoot: "/evidence/run",
            workspaceEvidenceRead: "deny",
            ...clients,
            ...testCase.clients(clients),
          }),
        (error: unknown) =>
          error instanceof ResultStoreError &&
          error.code === "permission_denied" &&
          error.message.includes(testCase.name.split(" ")[0] ?? ""),
      );
      assert.equal(clients.store.objects.size, 0);
    }
  });

  it("does not accept missing or generic failures as authorization denial", async () => {
    const clients = isolatedClients();
    const workspaceClient = new ScopedProbeClient(clients.store, ["/workspaces/run"], ["/workspaces/run"]);
    workspaceClient.read = async (path: string) => {
      if (path.startsWith("/workspaces/run/")) {
        const current = clients.store.objects.get(path);
        if (current === undefined) throw new ProbeStatusError(404);
        return Uint8Array.from(current.data);
      }
      throw new ProbeStatusError(404);
    };
    await assert.rejects(
      async () =>
        await verifyRuntimeIsolation({
          workspaceRemoteRoot: "/workspaces/run",
          stateRemoteRoot: "/state/run",
          evidenceRemoteRoot: "/evidence/run",
          workspaceEvidenceRead: "deny",
          ...clients,
          workspaceClient,
        }),
      (error: unknown) => error instanceof ResultStoreError && error.code === "permission_denied",
    );
    assert.equal(clients.store.objects.size, 0);
  });

  it("cleans a probe when its owner cannot read back the created object", async () => {
    const clients = isolatedClients();
    const stateClient = new ScopedProbeClient(clients.store, [], ["/state/run"]);
    await assert.rejects(
      async () =>
        await verifyRuntimeIsolation({
          workspaceRemoteRoot: "/workspaces/run",
          stateRemoteRoot: "/state/run",
          evidenceRemoteRoot: "/evidence/run",
          workspaceEvidenceRead: "deny",
          ...clients,
          stateClient,
        }),
      (error: unknown) => error instanceof ResultStoreError && error.code === "unavailable",
    );
    assert.equal(clients.store.objects.size, 0);
  });
});
