import type { Storage } from "@earendil-works/pi-durable";
export type Drive9StorageProfile = {
    readonly kind: "server-fenced";
    readonly protocol: "drive9.writer-epoch/v1";
    readonly writerEpoch: string;
} | {
    readonly kind: "single-coordinator-preview";
};
export declare function storageProfile(storage: Storage): Drive9StorageProfile;
export declare function requireServerFencedStorage(storage: Storage): Extract<Drive9StorageProfile, {
    kind: "server-fenced";
}>;
export declare function markServerFencedStorage(storage: Storage, writerEpoch: string): void;
//# sourceMappingURL=profile.d.ts.map