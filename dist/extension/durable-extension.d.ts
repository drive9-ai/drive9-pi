import { type Extension } from "@earendil-works/pi-durable";
import type { WorkspaceMutationCoordinator } from "../workspace/types.js";
export declare const DRIVE9_DURABLE_EXTENSION_NAME = "drive9-durable";
export type Drive9DurableExtensionOptions = {
    readonly coordinator: WorkspaceMutationCoordinator;
    readonly prompt?: boolean;
};
export declare function createDrive9DurableExtension(options: Drive9DurableExtensionOptions): Extension;
//# sourceMappingURL=durable-extension.d.ts.map