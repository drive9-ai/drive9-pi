import { Drive9ProtocolError } from "../core/errors.js";
const serverFencedStorage = new WeakMap();
export function storageProfile(storage) {
    return serverFencedStorage.get(storage) ?? { kind: "single-coordinator-preview" };
}
export function requireServerFencedStorage(storage) {
    const profile = storageProfile(storage);
    if (profile.kind !== "server-fenced") {
        throw new Drive9ProtocolError("stable_storage_required", "stable Drive9 publication requires storage-enforced writer epochs");
    }
    return profile;
}
export function markServerFencedStorage(storage, writerEpoch) {
    if (typeof writerEpoch !== "string" || writerEpoch.length === 0) {
        throw new Drive9ProtocolError("invalid_protocol_record", "writer epoch must be a non-empty string");
    }
    serverFencedStorage.set(storage, {
        kind: "server-fenced",
        protocol: "drive9.writer-epoch/v1",
        writerEpoch,
    });
}
//# sourceMappingURL=profile.js.map