import { posix } from "node:path";
import { normalizeDrive9AbsoluteRoot, normalizeDrive9PathText } from "./drive9-path.js";
import { PersistentToolResultStore } from "./tool-result-store.js";
import { ResultStoreError, } from "./tool-result-types.js";
function errorValue(value) {
    if (value instanceof Error)
        return value;
    return new Error(typeof value === "string" ? value : String(value));
}
function statusCode(value) {
    if (typeof value !== "object" || value === null || !("statusCode" in value))
        return undefined;
    const code = value.statusCode;
    return typeof code === "number" ? code : undefined;
}
function mapStatusCode(code) {
    if (code === 401 || code === 403)
        return "permission_denied";
    if (code === 404)
        return "not_found";
    if (code === 409 || code === 412)
        return "conflict";
    return "unavailable";
}
function mapDrive9Error(value) {
    if (value instanceof ResultStoreError)
        return value;
    const cause = errorValue(value);
    return new ResultStoreError(mapStatusCode(statusCode(value)), cause.message, cause);
}
function normalizedAbsoluteRoot(value) {
    return normalizeDrive9AbsoluteRoot(value, "evidenceRoot", (message) => new ResultStoreError("invalid", message));
}
function normalizedRelativePath(value) {
    const transportSafe = normalizeDrive9PathText(value, "result object path", false, (message) => new ResultStoreError("invalid", message));
    if (posix.isAbsolute(transportSafe) ||
        posix.normalize(transportSafe) !== transportSafe ||
        transportSafe === "." ||
        transportSafe.startsWith("../")) {
        throw new ResultStoreError("invalid", "result object path must be normalized and relative");
    }
    return transportSafe;
}
function positiveInteger(value, label) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new ResultStoreError("corrupt", `${label} must be a positive safe integer`);
    }
    return value;
}
function nonNegativeInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new ResultStoreError("corrupt", `${label} must be a non-negative safe integer`);
    }
    return value;
}
export class Drive9ResultStoreBackend {
    client;
    evidenceRoot;
    stableReadAttempts;
    constructor(options) {
        this.client = options.client;
        this.evidenceRoot = normalizedAbsoluteRoot(options.evidenceRoot);
        const attempts = options.stableReadAttempts ?? 3;
        if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) {
            throw new ResultStoreError("invalid", "stableReadAttempts must be between 1 and 10");
        }
        this.stableReadAttempts = attempts;
    }
    async create(path, data) {
        const remotePath = this.resolve(path);
        await this.ensureParentDirectories(remotePath);
        try {
            const revision = await this.client.writeWithRevision(remotePath, data, { expectedRevision: 0 });
            return { revision: positiveInteger(revision, "Drive9 write revision") };
        }
        catch (error) {
            throw mapDrive9Error(error);
        }
    }
    async read(path) {
        const remotePath = this.resolve(path);
        let changed = false;
        for (let attempt = 0; attempt < this.stableReadAttempts; attempt += 1) {
            try {
                const before = await this.client.stat(remotePath);
                if (before.isDir)
                    throw new ResultStoreError("corrupt", "result object is a directory");
                const beforeRevision = positiveInteger(before.revision, "Drive9 object revision");
                const beforeSize = nonNegativeInteger(before.size, "Drive9 object size");
                const data = await this.client.read(remotePath);
                const after = await this.client.stat(remotePath);
                if (after.isDir)
                    throw new ResultStoreError("corrupt", "result object became a directory");
                const afterRevision = positiveInteger(after.revision, "Drive9 object revision");
                const afterSize = nonNegativeInteger(after.size, "Drive9 object size");
                if (beforeRevision !== afterRevision || beforeSize !== afterSize) {
                    changed = true;
                    continue;
                }
                if (data.byteLength !== afterSize) {
                    throw new ResultStoreError("corrupt", "Drive9 read length does not match stable object metadata");
                }
                return { data: Uint8Array.from(data), revision: afterRevision };
            }
            catch (error) {
                if (error instanceof ResultStoreError)
                    throw error;
                throw mapDrive9Error(error);
            }
        }
        throw new ResultStoreError("unavailable", changed ? "Drive9 result object changed during every stable read attempt" : "Drive9 result object is unavailable");
    }
    async replace(path, data, expectedRevision) {
        positiveInteger(expectedRevision, "expectedRevision");
        const remotePath = this.resolve(path);
        try {
            const revision = await this.client.writeWithRevision(remotePath, data, { expectedRevision });
            return { revision: positiveInteger(revision, "Drive9 write revision") };
        }
        catch (error) {
            throw mapDrive9Error(error);
        }
    }
    resolve(path) {
        return posix.join(this.evidenceRoot, normalizedRelativePath(path));
    }
    async ensureParentDirectories(remotePath) {
        const parent = posix.dirname(remotePath);
        const rootParts = this.evidenceRoot.split("/").filter(Boolean);
        const parentParts = parent.split("/").filter(Boolean);
        for (let count = rootParts.length; count <= parentParts.length; count += 1) {
            const directory = `/${parentParts.slice(0, count).join("/")}`;
            try {
                await this.client.mkdir(directory, 0o700);
            }
            catch (error) {
                const mapped = mapDrive9Error(error);
                if (mapped.code !== "conflict")
                    throw mapped;
            }
        }
    }
}
export function createDrive9ResultStore(options) {
    const { client, evidenceRoot, stableReadAttempts, ...storeOptions } = options;
    return new PersistentToolResultStore({
        ...storeOptions,
        backend: new Drive9ResultStoreBackend({
            client,
            evidenceRoot,
            ...(stableReadAttempts === undefined ? {} : { stableReadAttempts }),
        }),
    });
}
//# sourceMappingURL=drive9-result-backend.js.map