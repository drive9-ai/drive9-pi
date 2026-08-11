import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { ResultStoreError } from "./tool-result-types.js";

export interface EvidenceProbeClient {
  writeWithRevision(
    path: string,
    data: Uint8Array,
    options: { expectedRevision: number },
  ): Promise<number>;
  read(path: string): Promise<Uint8Array>;
  delete(path: string): Promise<void>;
  mkdir(path: string, mode?: number): Promise<void>;
}

export interface EvidenceIsolationOptions {
  workspaceRemoteRoot: string;
  workspaceMountRemoteRoot: string;
  evidenceRemoteRoot: string;
  workspaceClient: EvidenceProbeClient;
  evidenceClient: EvidenceProbeClient;
}

export interface EvidenceIsolationReceipt {
  workspaceRootVerified: true;
  rootsDisjoint: true;
  evidenceCreateReadReplaceDelete: true;
  workspaceReadDenied: true;
  workspaceWriteDenied: true;
  workspaceDeleteDenied: true;
  verifiedAt: string;
}

function normalizeRemoteRoot(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    !posix.isAbsolute(value)
  ) {
    throw new ResultStoreError("invalid", `${label} must be an absolute POSIX path`);
  }
  const normalized = posix.normalize(value);
  if (normalized === "/") throw new ResultStoreError("invalid", `${label} cannot be the tenant root`);
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function containsPath(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
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

async function ensureProbeDirectory(client: EvidenceProbeClient, path: string): Promise<void> {
  try {
    await client.mkdir(path, 0o700);
  } catch (error) {
    if (responseStatus(error) !== 409) throw error;
  }
}

export async function verifyEvidenceIsolation(options: EvidenceIsolationOptions): Promise<EvidenceIsolationReceipt> {
  const workspaceRoot = normalizeRemoteRoot(options.workspaceRemoteRoot, "workspaceRemoteRoot");
  const mountRoot = normalizeRemoteRoot(options.workspaceMountRemoteRoot, "workspaceMountRemoteRoot");
  const evidenceRoot = normalizeRemoteRoot(options.evidenceRemoteRoot, "evidenceRemoteRoot");
  if (workspaceRoot !== mountRoot) {
    throw new ResultStoreError("invalid", "workspace mount root does not match the configured workspace remote root");
  }
  if (containsPath(workspaceRoot, evidenceRoot) || containsPath(evidenceRoot, workspaceRoot)) {
    throw new ResultStoreError("invalid", "workspace and evidence roots must be disjoint");
  }

  const probeDirectory = posix.join(evidenceRoot, ".drive9-pi-probes");
  const probePath = posix.join(probeDirectory, `${randomUUID()}.probe`);
  const first = Buffer.from(`drive9-pi-probe:${randomUUID()}`, "utf8");
  const second = Buffer.from(`drive9-pi-probe-replaced:${randomUUID()}`, "utf8");
  let created = false;
  try {
    await ensureProbeDirectory(options.evidenceClient, evidenceRoot);
    await ensureProbeDirectory(options.evidenceClient, probeDirectory);
    const firstRevision = await options.evidenceClient.writeWithRevision(probePath, first, { expectedRevision: 0 });
    if (!Number.isSafeInteger(firstRevision) || firstRevision <= 0) {
      throw new ResultStoreError("corrupt", "evidence probe create returned an invalid revision");
    }
    created = true;
    const firstRead = await options.evidenceClient.read(probePath);
    if (!Buffer.from(firstRead).equals(first)) throw new ResultStoreError("corrupt", "evidence probe read mismatch");

    await requireDenied("workspace credential evidence read", async () => await options.workspaceClient.read(probePath));
    await requireDenied(
      "workspace credential evidence write",
      async () => await options.workspaceClient.writeWithRevision(probePath, second, { expectedRevision: firstRevision }),
    );
    await requireDenied("workspace credential evidence delete", async () => await options.workspaceClient.delete(probePath));

    const secondRevision = await options.evidenceClient.writeWithRevision(probePath, second, {
      expectedRevision: firstRevision,
    });
    if (!Number.isSafeInteger(secondRevision) || secondRevision <= firstRevision) {
      throw new ResultStoreError("corrupt", "evidence probe replace returned an invalid revision");
    }
    const secondRead = await options.evidenceClient.read(probePath);
    if (!Buffer.from(secondRead).equals(second)) throw new ResultStoreError("corrupt", "evidence probe replace mismatch");
    await options.evidenceClient.delete(probePath);
    created = false;
  } catch (error) {
    if (error instanceof ResultStoreError) throw error;
    const cause = error instanceof Error ? error : new Error(String(error));
    throw new ResultStoreError("unavailable", "evidence isolation probe failed", cause);
  } finally {
    if (created) {
      try {
        await options.evidenceClient.delete(probePath);
      } catch {}
    }
  }

  return {
    workspaceRootVerified: true,
    rootsDisjoint: true,
    evidenceCreateReadReplaceDelete: true,
    workspaceReadDenied: true,
    workspaceWriteDenied: true,
    workspaceDeleteDenied: true,
    verifiedAt: new Date().toISOString(),
  };
}
