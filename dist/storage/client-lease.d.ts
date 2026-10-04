import type { Storage } from "@earendil-works/pi-durable";
import type { Drive9DurableFileSystemClient } from "../drive9-durable-file-system.js";
export interface Drive9ClientLeasePreviewOptions {
    readonly kind: "drive9-cas-lease-preview";
    /** Unique diagnostic identity for this coordinator process. */
    readonly holderId: string;
    /** Absolute Drive9 path outside stateRoot used for the cooperative lease record. */
    readonly leasePath: string;
    /** Client-wall-clock lease lifetime. Must be a positive integer. */
    readonly leaseDurationMs: number;
    /** Renewal cadence. Must be positive and less than leaseDurationMs. */
    readonly renewIntervalMs: number;
}
export declare class Drive9ClientLease {
    private readonly client;
    private readonly leasePath;
    private readonly leaseDurationMs;
    private readonly renewIntervalMs;
    private record;
    private renewalTail;
    private timer;
    private lost;
    private closing;
    private constructor();
    static acquire(clientValue: Drive9DurableFileSystemClient, stateRootValue: string, options: Drive9ClientLeasePreviewOptions): Promise<Drive9ClientLease>;
    ensureHeld(): Promise<void>;
    close(): Promise<void>;
    private renewOnce;
    private markLost;
    private scheduleRenewal;
    private clearTimer;
}
export declare function wrapStorageWithClientLease(inner: Storage, lease: Drive9ClientLease): Storage;
//# sourceMappingURL=client-lease.d.ts.map