import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { normalizeDrive9AbsoluteRoot } from "./drive9-path.js";
import { ResultStoreError } from "./tool-result-types.js";

export interface RuntimeIsolationProbeClient {
  writeWithRevision(
    path: string,
    data: Uint8Array,
    options: { expectedRevision: number },
  ): Promise<number>;
  read(path: string): Promise<Uint8Array>;
  delete(path: string): Promise<void>;
  mkdir(path: string, mode?: number): Promise<void>;
}

export interface RuntimeIsolationOptions {
  workspaceRemoteRoot: string;
  stateRemoteRoot: string;
  evidenceRemoteRoot: string;
  workspaceClient: RuntimeIsolationProbeClient;
  stateClient: RuntimeIsolationProbeClient;
  evidenceClient: RuntimeIsolationProbeClient;
  workspaceEvidenceRead: "allow" | "deny";
}

export interface RuntimeIsolationReceipt {
  rootsDisjoint: true;
  workspaceCreateReadReplaceDelete: true;
  stateCreateReadReplaceDelete: true;
  evidenceCreateReadReplaceDelete: true;
  workspaceStateReadDenied: true;
  workspaceStateWriteDenied: true;
  workspaceStateDeleteDenied: true;
  workspaceEvidenceRead: "allowed" | "denied";
  workspaceEvidenceWriteDenied: true;
  workspaceEvidenceDeleteDenied: true;
  stateWorkspaceWriteDenied: true;
  stateWorkspaceDeleteDenied: true;
  evidenceStateWriteDenied: true;
  evidenceStateDeleteDenied: true;
  verifiedAt: string;
}

interface Probe {
  client: RuntimeIsolationProbeClient;
  path: string;
  first: Uint8Array;
  second: Uint8Array;
  revision: number;
  created: boolean;
}

function normalizeRemoteRoot(value: string, label: string): string {
  return normalizeDrive9AbsoluteRoot(value, label, (message) => new ResultStoreError("invalid", message));
}

function containsPath(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

function requireDisjointRoots(roots: ReadonlyArray<{ label: string; path: string }>): void {
  for (let leftIndex = 0; leftIndex < roots.length; leftIndex += 1) {
    const left = roots[leftIndex];
    if (left === undefined) throw new ResultStoreError("corrupt", "runtime root is missing");
    for (let rightIndex = leftIndex + 1; rightIndex < roots.length; rightIndex += 1) {
      const right = roots[rightIndex];
      if (right === undefined) throw new ResultStoreError("corrupt", "runtime root is missing");
      if (containsPath(left.path, right.path) || containsPath(right.path, left.path)) {
        throw new ResultStoreError("invalid", `${left.label} and ${right.label} must be disjoint`);
      }
    }
  }
}

function responseStatus(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || !("statusCode" in value)) return undefined;
  const status = (value as { statusCode?: unknown }).statusCode;
  return typeof status === "number" ? status : undefined;
}

async function requireDenied(label: string, operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const status = responseStatus(error);
    if (status === 401 || status === 403) return;
    throw new ResultStoreError("permission_denied", `${label} did not return an explicit authorization denial`);
  }
  throw new ResultStoreError("permission_denied", `${label} unexpectedly succeeded`);
}

async function ensureProbeDirectory(client: RuntimeIsolationProbeClient, path: string): Promise<void> {
  try {
    await client.mkdir(path, 0o700);
  } catch (error) {
    if (responseStatus(error) !== 409) throw error;
  }
}

async function createProbe(
  client: RuntimeIsolationProbeClient,
  root: string,
  authority: string,
): Promise<Probe> {
  const directory = posix.join(root, ".drive9-pi-probes");
  const path = posix.join(directory, `${randomUUID()}.probe`);
  const first = Buffer.from(`drive9-pi-${authority}-probe:${randomUUID()}`, "utf8");
  const second = Buffer.from(`drive9-pi-${authority}-replaced:${randomUUID()}`, "utf8");
  await ensureProbeDirectory(client, root);
  await ensureProbeDirectory(client, directory);
  let created = false;
  try {
    const revision = await client.writeWithRevision(path, first, { expectedRevision: 0 });
    created = true;
    if (!Number.isSafeInteger(revision) || revision <= 0) {
      throw new ResultStoreError("corrupt", `${authority} probe create returned an invalid revision`);
    }
    const read = await client.read(path);
    if (!Buffer.from(read).equals(first)) {
      throw new ResultStoreError("corrupt", `${authority} probe read mismatch`);
    }
    return { client, path, first, second, revision, created: true };
  } catch (error) {
    if (created) {
      try {
        await client.delete(path);
      } catch {}
    }
    throw error;
  }
}

async function replaceAndDeleteProbe(probe: Probe, authority: string): Promise<void> {
  const revision = await probe.client.writeWithRevision(probe.path, probe.second, {
    expectedRevision: probe.revision,
  });
  if (!Number.isSafeInteger(revision) || revision <= probe.revision) {
    throw new ResultStoreError("corrupt", `${authority} probe replace returned an invalid revision`);
  }
  const read = await probe.client.read(probe.path);
  if (!Buffer.from(read).equals(probe.second)) {
    throw new ResultStoreError("corrupt", `${authority} probe replace mismatch`);
  }
  await probe.client.delete(probe.path);
  probe.created = false;
}

async function cleanupProbe(probe: Probe | undefined): Promise<void> {
  if (probe?.created !== true) return;
  try {
    await probe.client.delete(probe.path);
  } catch {}
}

function unavailable(error: unknown): ResultStoreError {
  if (error instanceof ResultStoreError) return error;
  const cause = error instanceof Error ? error : new Error(String(error));
  return new ResultStoreError("unavailable", "runtime isolation probe failed", cause);
}

export async function verifyRuntimeIsolation(
  options: RuntimeIsolationOptions,
): Promise<RuntimeIsolationReceipt> {
  if (options.workspaceEvidenceRead !== "allow" && options.workspaceEvidenceRead !== "deny") {
    throw new ResultStoreError("invalid", "workspaceEvidenceRead must be allow or deny");
  }
  const workspaceRoot = normalizeRemoteRoot(options.workspaceRemoteRoot, "workspaceRemoteRoot");
  const stateRoot = normalizeRemoteRoot(options.stateRemoteRoot, "stateRemoteRoot");
  const evidenceRoot = normalizeRemoteRoot(options.evidenceRemoteRoot, "evidenceRemoteRoot");
  requireDisjointRoots([
    { label: "workspaceRemoteRoot", path: workspaceRoot },
    { label: "stateRemoteRoot", path: stateRoot },
    { label: "evidenceRemoteRoot", path: evidenceRoot },
  ]);

  let workspaceProbe: Probe | undefined;
  let stateProbe: Probe | undefined;
  let evidenceProbe: Probe | undefined;
  try {
    workspaceProbe = await createProbe(options.workspaceClient, workspaceRoot, "workspace");
    stateProbe = await createProbe(options.stateClient, stateRoot, "state");
    evidenceProbe = await createProbe(options.evidenceClient, evidenceRoot, "evidence");

    await requireDenied("workspace credential state read", async () =>
      await options.workspaceClient.read(stateProbe!.path));
    await requireDenied("workspace credential state write", async () =>
      await options.workspaceClient.writeWithRevision(stateProbe!.path, stateProbe!.second, {
        expectedRevision: stateProbe!.revision,
      }));
    await requireDenied("workspace credential state delete", async () =>
      await options.workspaceClient.delete(stateProbe!.path));

    if (options.workspaceEvidenceRead === "allow") {
      const read = await options.workspaceClient.read(evidenceProbe.path);
      if (!Buffer.from(read).equals(evidenceProbe.first)) {
        throw new ResultStoreError("corrupt", "workspace credential evidence read mismatch");
      }
    } else {
      await requireDenied("workspace credential evidence read", async () =>
        await options.workspaceClient.read(evidenceProbe!.path));
    }
    await requireDenied("workspace credential evidence write", async () =>
      await options.workspaceClient.writeWithRevision(evidenceProbe!.path, evidenceProbe!.second, {
        expectedRevision: evidenceProbe!.revision,
      }));
    await requireDenied("workspace credential evidence delete", async () =>
      await options.workspaceClient.delete(evidenceProbe!.path));

    await requireDenied("state credential workspace write", async () =>
      await options.stateClient.writeWithRevision(workspaceProbe!.path, workspaceProbe!.second, {
        expectedRevision: workspaceProbe!.revision,
      }));
    await requireDenied("state credential workspace delete", async () =>
      await options.stateClient.delete(workspaceProbe!.path));

    await requireDenied("evidence credential state write", async () =>
      await options.evidenceClient.writeWithRevision(stateProbe!.path, stateProbe!.second, {
        expectedRevision: stateProbe!.revision,
      }));
    await requireDenied("evidence credential state delete", async () =>
      await options.evidenceClient.delete(stateProbe!.path));

    await replaceAndDeleteProbe(workspaceProbe, "workspace");
    await replaceAndDeleteProbe(stateProbe, "state");
    await replaceAndDeleteProbe(evidenceProbe, "evidence");
  } catch (error) {
    throw unavailable(error);
  } finally {
    await cleanupProbe(workspaceProbe);
    await cleanupProbe(stateProbe);
    await cleanupProbe(evidenceProbe);
  }

  return {
    rootsDisjoint: true,
    workspaceCreateReadReplaceDelete: true,
    stateCreateReadReplaceDelete: true,
    evidenceCreateReadReplaceDelete: true,
    workspaceStateReadDenied: true,
    workspaceStateWriteDenied: true,
    workspaceStateDeleteDenied: true,
    workspaceEvidenceRead: options.workspaceEvidenceRead === "allow" ? "allowed" : "denied",
    workspaceEvidenceWriteDenied: true,
    workspaceEvidenceDeleteDenied: true,
    stateWorkspaceWriteDenied: true,
    stateWorkspaceDeleteDenied: true,
    evidenceStateWriteDenied: true,
    evidenceStateDeleteDenied: true,
    verifiedAt: new Date().toISOString(),
  };
}
