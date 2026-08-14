import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { normalizeDrive9AbsoluteRoot } from "./drive9-path.js";
import { ResultStoreError } from "./tool-result-types.js";
function normalizeRemoteRoot(value, label) {
    return normalizeDrive9AbsoluteRoot(value, label, (message) => new ResultStoreError("invalid", message));
}
function containsPath(parent, child) {
    return child === parent || child.startsWith(`${parent}/`);
}
function responseStatus(value) {
    if (typeof value !== "object" || value === null || !("statusCode" in value))
        return undefined;
    const status = value.statusCode;
    return typeof status === "number" ? status : undefined;
}
async function requireDenied(label, operation) {
    try {
        await operation();
    }
    catch (error) {
        const status = responseStatus(error);
        if (status === 401 || status === 403)
            return;
        throw new ResultStoreError("permission_denied", `${label} did not return an explicit authorization denial`);
    }
    throw new ResultStoreError("permission_denied", `${label} unexpectedly succeeded`);
}
async function ensureProbeDirectory(client, path) {
    try {
        await client.mkdir(path, 0o700);
    }
    catch (error) {
        if (responseStatus(error) !== 409)
            throw error;
    }
}
export async function verifyEvidenceIsolation(options) {
    const workspaceRoot = normalizeRemoteRoot(options.workspaceRemoteRoot, "workspaceRemoteRoot");
    const evidenceRoot = normalizeRemoteRoot(options.evidenceRemoteRoot, "evidenceRemoteRoot");
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
        if (!Buffer.from(firstRead).equals(first))
            throw new ResultStoreError("corrupt", "evidence probe read mismatch");
        await requireDenied("workspace credential evidence read", async () => await options.workspaceClient.read(probePath));
        await requireDenied("workspace credential evidence write", async () => await options.workspaceClient.writeWithRevision(probePath, second, { expectedRevision: firstRevision }));
        await requireDenied("workspace credential evidence delete", async () => await options.workspaceClient.delete(probePath));
        const secondRevision = await options.evidenceClient.writeWithRevision(probePath, second, {
            expectedRevision: firstRevision,
        });
        if (!Number.isSafeInteger(secondRevision) || secondRevision <= firstRevision) {
            throw new ResultStoreError("corrupt", "evidence probe replace returned an invalid revision");
        }
        const secondRead = await options.evidenceClient.read(probePath);
        if (!Buffer.from(secondRead).equals(second))
            throw new ResultStoreError("corrupt", "evidence probe replace mismatch");
        await options.evidenceClient.delete(probePath);
        created = false;
    }
    catch (error) {
        if (error instanceof ResultStoreError)
            throw error;
        const cause = error instanceof Error ? error : new Error(String(error));
        throw new ResultStoreError("unavailable", "evidence isolation probe failed", cause);
    }
    finally {
        if (created) {
            try {
                await options.evidenceClient.delete(probePath);
            }
            catch { }
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
//# sourceMappingURL=evidence-isolation.js.map