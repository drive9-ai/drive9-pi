import type { Context } from "@earendil-works/chord";
import type { Storage } from "@earendil-works/pi-durable";
import { type Drive9DurableFileSystemClient } from "../drive9-durable-file-system.js";
import { type Drive9ClientLeasePreviewOptions } from "./client-lease.js";
export interface Drive9SingleCoordinatorStorageOptions {
    readonly client: Drive9DurableFileSystemClient;
    /** Existing absolute Drive9 directory reserved for one Pi session's durable state. */
    readonly stateRoot: string;
    /**
     * Select external exclusivity or the cooperative revision-CAS lease preview.
     * Neither mode is a storage-enforced stale-writer fence.
     */
    readonly coordination: "externally-exclusive" | Drive9ClientLeasePreviewOptions;
    /** Stable namespace identity for equal state roots. Defaults to the filesystem namespace id. */
    readonly id?: string;
}
/**
 * Opens Pi's portable JSONL storage on a Drive9 namespace.
 *
 * This is deliberately a single-coordinator preview. Drive9 file operations
 * do not carry a server-enforced writer epoch, so this adapter cannot reject a
 * delayed stale writer after lease expiry or process takeover. Callers must
 * either keep the state root externally exclusive for the entire storage
 * lifetime or explicitly select the cooperative CAS-lease preview. The lease
 * checks ownership before and after each Pi commit and poisons the adapter when
 * the post-commit check fails, but it cannot roll back an in-flight JSONL
 * commit or make its multiple file mutations atomic.
 */
export declare function openDrive9SingleCoordinatorStorage(options: Drive9SingleCoordinatorStorageOptions, context: Context): Promise<Storage>;
//# sourceMappingURL=jsonl-preview.d.ts.map