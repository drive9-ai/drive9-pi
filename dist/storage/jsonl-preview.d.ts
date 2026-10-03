import type { Context } from "@earendil-works/chord";
import type { Storage } from "@earendil-works/pi-durable";
import { type Drive9DurableFileSystemClient } from "../drive9-durable-file-system.js";
export interface Drive9SingleCoordinatorStorageOptions {
    readonly client: Drive9DurableFileSystemClient;
    /** Existing absolute Drive9 directory reserved for one Pi session's durable state. */
    readonly stateRoot: string;
    /**
     * Required acknowledgement that another coordinator prevents concurrent or
     * automatic-takeover writers for this state root.
     */
    readonly coordination: "externally-exclusive";
    /** Stable namespace identity for equal state roots. Defaults to the filesystem namespace id. */
    readonly id?: string;
}
/**
 * Opens Pi's portable JSONL storage on a Drive9 namespace.
 *
 * This is deliberately a single-coordinator preview. Drive9 file operations
 * do not carry a server-enforced writer epoch, so this adapter cannot reject a
 * delayed stale writer after lease expiry or process takeover. The caller must
 * keep the state root externally exclusive for the entire storage lifetime.
 */
export declare function openDrive9SingleCoordinatorStorage(options: Drive9SingleCoordinatorStorageOptions, context: Context): Promise<Storage>;
//# sourceMappingURL=jsonl-preview.d.ts.map