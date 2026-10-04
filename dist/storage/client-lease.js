import { randomUUID } from "node:crypto";
import { Drive9ProtocolError, protocolCause } from "../core/errors.js";
import { normalizeDrive9AbsoluteRoot } from "../drive9-path.js";
const LEASE_VERSION = 1;
const STABLE_READ_ATTEMPTS = 8;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder("utf-8", { fatal: true });
function statusCode(value) {
    if (typeof value !== "object" || value === null)
        return undefined;
    if ("statusCode" in value && typeof value.statusCode === "number")
        return value.statusCode;
    if ("status" in value && typeof value.status === "number")
        return value.status;
    return undefined;
}
function isMissing(value) {
    return statusCode(value) === 404 || protocolCause(value).message.toLowerCase().includes("not found");
}
function isConflict(value) {
    const message = protocolCause(value).message.toLowerCase();
    return statusCode(value) === 409 || statusCode(value) === 412 || message.includes("revision conflict");
}
function positiveInteger(value, label) {
    if (!Number.isSafeInteger(value) || Number(value) <= 0) {
        throw new TypeError(`${label} must be a positive safe integer`);
    }
    return Number(value);
}
function protocolPositiveInteger(value, label) {
    if (!Number.isSafeInteger(value) || Number(value) <= 0) {
        throw new Drive9ProtocolError("invalid_protocol_record", `${label} must be a positive safe integer`);
    }
    return Number(value);
}
function nonNegativeInteger(value, label) {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new Drive9ProtocolError("invalid_protocol_record", `${label} must be a non-negative safe integer`);
    }
    return Number(value);
}
function nonEmptyString(value, label) {
    if (typeof value !== "string" || value.length === 0) {
        throw new Drive9ProtocolError("invalid_protocol_record", `${label} must be a non-empty string`);
    }
    return value;
}
function leaseDeadline(now, leaseDurationMs) {
    const expiresAtMs = now + leaseDurationMs;
    if (!Number.isSafeInteger(expiresAtMs)) {
        throw new TypeError("leaseDurationMs is too large");
    }
    return expiresAtMs;
}
function parseLeaseRecord(bytes, expectedStateRoot) {
    let value;
    try {
        value = JSON.parse(DECODER.decode(bytes));
    }
    catch (error) {
        throw new Drive9ProtocolError("invalid_protocol_record", "Drive9 session lease is not valid JSON", protocolCause(error));
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Drive9ProtocolError("invalid_protocol_record", "Drive9 session lease must be an object");
    }
    const object = value;
    if (object.version !== LEASE_VERSION) {
        throw new Drive9ProtocolError("invalid_protocol_record", "unsupported Drive9 session lease version");
    }
    const stateRoot = nonEmptyString(object.stateRoot, "lease stateRoot");
    if (stateRoot !== expectedStateRoot) {
        throw new Drive9ProtocolError("invalid_protocol_record", "Drive9 session lease stateRoot does not match");
    }
    return {
        version: LEASE_VERSION,
        stateRoot,
        holderId: nonEmptyString(object.holderId, "lease holderId"),
        leaseId: nonEmptyString(object.leaseId, "lease leaseId"),
        epoch: protocolPositiveInteger(object.epoch, "lease epoch"),
        expiresAtMs: nonNegativeInteger(object.expiresAtMs, "lease expiresAtMs"),
    };
}
function encodeLeaseRecord(record) {
    return ENCODER.encode(`${JSON.stringify(record)}\n`);
}
function sameLease(left, right) {
    return (left.version === right.version &&
        left.stateRoot === right.stateRoot &&
        left.holderId === right.holderId &&
        left.leaseId === right.leaseId &&
        left.epoch === right.epoch);
}
function leaseLost(message) {
    return new Drive9ProtocolError("session_lease_lost", message);
}
function leaseUnavailable(message, cause) {
    return new Drive9ProtocolError("session_lease_unavailable", message, protocolCause(cause));
}
function validatedClient(client) {
    if (typeof client.writeWithRevision !== "function") {
        throw new TypeError("drive9-cas-lease-preview requires client.writeWithRevision()");
    }
    return client;
}
export class Drive9ClientLease {
    client;
    leasePath;
    leaseDurationMs;
    renewIntervalMs;
    record;
    renewalTail = Promise.resolve();
    timer;
    lost;
    closing = false;
    constructor(client, leasePath, leaseDurationMs, renewIntervalMs, record) {
        this.client = client;
        this.leasePath = leasePath;
        this.leaseDurationMs = leaseDurationMs;
        this.renewIntervalMs = renewIntervalMs;
        this.record = record;
        this.scheduleRenewal();
    }
    static async acquire(clientValue, stateRootValue, options) {
        const client = validatedClient(clientValue);
        const stateRoot = normalizeDrive9AbsoluteRoot(stateRootValue, "stateRoot", (message) => new TypeError(message));
        const leasePath = normalizeDrive9AbsoluteRoot(options.leasePath, "leasePath", (message) => new TypeError(message));
        if (leasePath === stateRoot || leasePath.startsWith(`${stateRoot}/`)) {
            throw new TypeError("leasePath must be outside stateRoot");
        }
        if (typeof options.holderId !== "string" || options.holderId.length === 0) {
            throw new TypeError("holderId must be a non-empty string");
        }
        const leaseDurationMs = positiveInteger(options.leaseDurationMs, "leaseDurationMs");
        const renewIntervalMs = positiveInteger(options.renewIntervalMs, "renewIntervalMs");
        if (renewIntervalMs >= leaseDurationMs) {
            throw new TypeError("renewIntervalMs must be less than leaseDurationMs");
        }
        const leaseId = randomUUID();
        for (let attempt = 0; attempt < STABLE_READ_ATTEMPTS; attempt += 1) {
            const current = await readLeaseSnapshot(client, leasePath, stateRoot);
            const now = Date.now();
            if (current !== undefined && current.record.expiresAtMs > now) {
                throw new Drive9ProtocolError("session_already_open", `Drive9 session is already held by ${current.record.holderId}`);
            }
            const record = {
                version: LEASE_VERSION,
                stateRoot,
                holderId: options.holderId,
                leaseId,
                epoch: current === undefined
                    ? 1
                    : protocolPositiveInteger(current.record.epoch + 1, "next lease epoch"),
                expiresAtMs: leaseDeadline(now, leaseDurationMs),
            };
            try {
                await client.writeWithRevision(leasePath, encodeLeaseRecord(record), {
                    expectedRevision: current?.revision ?? 0,
                });
                if (record.expiresAtMs <= Date.now()) {
                    throw leaseLost("Drive9 session lease expired during acquisition");
                }
                return new Drive9ClientLease(client, leasePath, leaseDurationMs, renewIntervalMs, record);
            }
            catch (error) {
                if (error instanceof Drive9ProtocolError && error.code === "session_lease_lost")
                    throw error;
                if (isConflict(error))
                    continue;
                const reconciled = await reconcileLeaseWrite(client, leasePath, stateRoot, record);
                if (reconciled !== undefined && reconciled.record.expiresAtMs > Date.now()) {
                    return new Drive9ClientLease(client, leasePath, leaseDurationMs, renewIntervalMs, reconciled.record);
                }
                throw leaseUnavailable("failed to acquire Drive9 session lease", error);
            }
        }
        throw leaseUnavailable("Drive9 session lease changed too many times during acquisition", new Error("conflict"));
    }
    async ensureHeld() {
        if (this.lost !== undefined)
            throw this.lost;
        if (this.closing)
            throw leaseLost("Drive9 session lease is closing");
        this.clearTimer();
        const renewal = this.renewalTail.then(async () => await this.renewOnce());
        this.renewalTail = renewal.catch(() => undefined);
        try {
            await renewal;
        }
        finally {
            this.scheduleRenewal();
        }
    }
    async close() {
        if (this.closing)
            return;
        this.closing = true;
        this.clearTimer();
        await this.renewalTail;
        try {
            const current = await readLeaseSnapshot(this.client, this.leasePath, this.record.stateRoot);
            if (current === undefined || !sameLease(current.record, this.record))
                return;
            const released = { ...current.record, expiresAtMs: 0 };
            await this.client.writeWithRevision(this.leasePath, encodeLeaseRecord(released), {
                expectedRevision: current.revision,
            });
        }
        catch {
            // Best-effort release must never delete or overwrite a successor lease.
        }
    }
    async renewOnce() {
        if (this.lost !== undefined)
            throw this.lost;
        let current;
        try {
            current = await readLeaseSnapshot(this.client, this.leasePath, this.record.stateRoot);
        }
        catch (error) {
            if (Date.now() >= this.record.expiresAtMs) {
                throw this.markLost("Drive9 session lease expired while unavailable");
            }
            throw leaseUnavailable("failed to verify Drive9 session lease", error);
        }
        const now = Date.now();
        if (current === undefined || !sameLease(current.record, this.record)) {
            throw this.markLost("Drive9 session lease is no longer owned by this coordinator");
        }
        if (current.record.expiresAtMs <= now)
            throw this.markLost("Drive9 session lease expired");
        const renewed = {
            ...current.record,
            expiresAtMs: leaseDeadline(now, this.leaseDurationMs),
        };
        try {
            await this.client.writeWithRevision(this.leasePath, encodeLeaseRecord(renewed), {
                expectedRevision: current.revision,
            });
            if (renewed.expiresAtMs <= Date.now()) {
                throw this.markLost("Drive9 session lease expired during renewal");
            }
            this.record = renewed;
        }
        catch (error) {
            if (error instanceof Drive9ProtocolError && error.code === "session_lease_lost")
                throw error;
            if (isConflict(error)) {
                throw this.markLost("Drive9 session lease changed during renewal");
            }
            const reconciled = await reconcileLeaseWrite(this.client, this.leasePath, this.record.stateRoot, renewed);
            if (reconciled === undefined || reconciled.record.expiresAtMs <= Date.now()) {
                if (Date.now() >= this.record.expiresAtMs) {
                    throw this.markLost("Drive9 session lease renewal outcome is unknown after expiry");
                }
                throw leaseUnavailable("failed to renew Drive9 session lease", error);
            }
            this.record = reconciled.record;
        }
    }
    markLost(message) {
        this.lost ??= leaseLost(message);
        this.clearTimer();
        return this.lost;
    }
    scheduleRenewal() {
        if (this.closing || this.lost !== undefined || this.timer !== undefined)
            return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.ensureHeld().catch(() => undefined);
        }, this.renewIntervalMs);
        this.timer.unref?.();
    }
    clearTimer() {
        if (this.timer === undefined)
            return;
        clearTimeout(this.timer);
        this.timer = undefined;
    }
}
async function readLeaseSnapshot(client, leasePath, stateRoot) {
    for (let attempt = 0; attempt < STABLE_READ_ATTEMPTS; attempt += 1) {
        let before;
        try {
            before = await client.stat(leasePath);
        }
        catch (error) {
            if (isMissing(error))
                return undefined;
            throw error;
        }
        if (before.isDir) {
            throw new Drive9ProtocolError("invalid_protocol_record", "Drive9 session lease path is a directory");
        }
        let bytes;
        try {
            bytes = await client.read(leasePath);
        }
        catch (error) {
            if (isMissing(error))
                continue;
            throw error;
        }
        let after;
        try {
            after = await client.stat(leasePath);
        }
        catch (error) {
            if (isMissing(error))
                continue;
            throw error;
        }
        if (before.revision !== after.revision)
            continue;
        return { record: parseLeaseRecord(bytes, stateRoot), revision: after.revision };
    }
    throw leaseUnavailable("Drive9 session lease did not stabilize while reading", new Error("revision changed"));
}
async function reconcileLeaseWrite(client, leasePath, stateRoot, expected) {
    try {
        const current = await readLeaseSnapshot(client, leasePath, stateRoot);
        if (current !== undefined && sameLease(current.record, expected) && current.record.expiresAtMs === expected.expiresAtMs) {
            return current;
        }
    }
    catch {
        return undefined;
    }
    return undefined;
}
export function wrapStorageWithClientLease(inner, lease) {
    let poisoned;
    return {
        async commit(writes, context) {
            if (poisoned !== undefined)
                throw poisoned;
            await lease.ensureHeld();
            let sequence;
            let commitError;
            try {
                sequence = await inner.commit(writes, context);
            }
            catch (error) {
                commitError = error;
            }
            let leaseError;
            try {
                await lease.ensureHeld();
            }
            catch (error) {
                leaseError = error;
                poisoned = new Drive9ProtocolError("session_poisoned", "Drive9 session lease could not be verified after a storage commit; reopen and recover", protocolCause(error));
            }
            if (commitError !== undefined && leaseError !== undefined) {
                throw new AggregateError([commitError, leaseError], "storage commit and post-commit lease verification failed");
            }
            if (commitError !== undefined)
                throw commitError;
            if (leaseError !== undefined)
                throw poisoned;
            return sequence;
        },
        mintId: inner.mintId.bind(inner),
        conversation: inner.conversation.bind(inner),
        scanConversations: inner.scanConversations.bind(inner),
        entry: inner.entry.bind(inner),
        findLatestHeadMarker: inner.findLatestHeadMarker.bind(inner),
        scanEntries: inner.scanEntries.bind(inner),
        task: inner.task.bind(inner),
        scanTasks: inner.scanTasks.bind(inner),
        submission: inner.submission.bind(inner),
        scanSubmissions: inner.scanSubmissions.bind(inner),
        submissionByRequest: inner.submissionByRequest.bind(inner),
        findDocument: inner.findDocument.bind(inner),
        document: inner.document.bind(inner),
        scanDocuments: inner.scanDocuments.bind(inner),
        async close(context) {
            try {
                await inner.close(context);
            }
            finally {
                await lease.close();
            }
        },
    };
}
//# sourceMappingURL=client-lease.js.map