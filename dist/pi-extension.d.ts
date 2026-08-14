import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Drive9FileSystem, type Drive9FileSystemClient } from "./drive9-file-system.js";
import { type Drive9ExtensionConfigIO, type Drive9ExtensionConfigSource } from "./pi-extension-config.js";
export type Drive9ExtensionState = {
    mode: "inactive";
    reason: "unconfigured";
} | {
    mode: "disabled";
    source: "no-drive9" | "project" | "none";
} | {
    mode: "checking";
    root: string;
    source: Exclude<Drive9ExtensionConfigSource, "none" | "no-drive9">;
} | {
    mode: "drive9";
    fileSystem: Drive9FileSystem;
    root: string;
    source: Exclude<Drive9ExtensionConfigSource, "none" | "no-drive9">;
    checkedAt: string;
} | {
    mode: "error";
    message: string;
    source: Exclude<Drive9ExtensionConfigSource, "none">;
    root?: string;
};
export interface Drive9PiExtensionOptions {
    defaultRoot?: string;
    createClient?: () => Drive9FileSystemClient;
    environment?: Readonly<Record<string, string | undefined>>;
    configIO?: Drive9ExtensionConfigIO;
}
export declare function createDrive9PiExtension(options?: Drive9PiExtensionOptions): ExtensionFactory;
export default function drive9PiExtension(...args: Parameters<ExtensionFactory>): ReturnType<ExtensionFactory>;
//# sourceMappingURL=pi-extension.d.ts.map