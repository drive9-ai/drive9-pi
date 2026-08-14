export declare const DRIVE9_EXTENSION_CONFIG_VERSION: 1;
export declare const DRIVE9_EXTENSION_CONFIG_FILENAME = "drive9.json";
export declare const DRIVE9_PROJECT_TRUST_MARKER_FILENAME = "settings.json";
export interface Drive9ExtensionConfig {
    version: typeof DRIVE9_EXTENSION_CONFIG_VERSION;
    enabled: boolean;
    root: string;
}
export declare class Drive9ExtensionConfigError extends Error {
    readonly configPath: string | undefined;
    readonly cause: unknown;
    constructor(message: string, configPath?: string, cause?: unknown);
}
/** Minimal injectable filesystem surface used by config reads and atomic writes. */
export interface Drive9ExtensionConfigIO {
    pathExists(path: string): Promise<boolean>;
    readText(path: string): Promise<string>;
    makeDirectory(path: string): Promise<void>;
    writeTextExclusive(path: string, content: string): Promise<void>;
    rename(sourcePath: string, destinationPath: string): Promise<void>;
    remove(path: string): Promise<void>;
}
export declare function getDrive9ProjectConfigPath(cwd: string): string;
export declare function getDrive9ProjectTrustMarkerPath(cwd: string): string;
export declare function validateDrive9ExtensionConfig(value: unknown, configPath?: string): Drive9ExtensionConfig;
export declare function parseDrive9ExtensionConfig(text: string, configPath?: string): Drive9ExtensionConfig;
export interface EnsureDrive9ProjectTrustMarkerOptions {
    cwd: string;
    trusted: boolean;
    io?: Drive9ExtensionConfigIO;
}
/**
 * Ensure Pi can discover that this project requires a trust decision. Existing
 * project settings are preserved byte-for-byte; only a missing marker is
 * created, using an exclusive write to avoid races with Pi or the user.
 */
export declare function ensureDrive9ProjectTrustMarker(options: EnsureDrive9ProjectTrustMarkerOptions): Promise<string>;
export interface ReadDrive9ProjectConfigOptions {
    cwd: string;
    trusted: boolean;
    io?: Drive9ExtensionConfigIO;
}
/**
 * Read trusted project configuration. Untrusted projects are deliberately
 * indistinguishable from projects without configuration and are never read.
 */
export declare function readDrive9ProjectConfig(options: ReadDrive9ProjectConfigOptions): Promise<Drive9ExtensionConfig | undefined>;
export interface WriteDrive9ProjectConfigOptions {
    cwd: string;
    trusted: boolean;
    config: Drive9ExtensionConfig;
    io?: Drive9ExtensionConfigIO;
}
/** Write only the validated, non-sensitive config fields using same-directory rename. */
export declare function writeDrive9ProjectConfig(options: WriteDrive9ProjectConfigOptions): Promise<string>;
export type Drive9ExtensionConfigSource = "no-drive9" | "cli" | "env" | "project" | "programmatic" | "none";
export type ResolvedDrive9ExtensionConfig = {
    status: "active";
    source: "cli" | "env" | "project" | "programmatic";
    root: string;
} | {
    status: "inactive";
    source: "no-drive9" | "project" | "none";
    reason: "disabled" | "unconfigured";
} | {
    status: "error";
    source: Exclude<Drive9ExtensionConfigSource, "none">;
    error: Drive9ExtensionConfigError;
};
export interface ResolveDrive9ExtensionConfigOptions {
    cwd: string;
    projectTrusted: boolean;
    noDrive9?: boolean | string;
    cliRoot?: boolean | string;
    environment?: Readonly<Record<string, string | undefined>>;
    defaultRoot?: string;
    io?: Drive9ExtensionConfigIO;
}
/** Resolve activation lazily in documented precedence order. */
export declare function resolveDrive9ExtensionConfig(options: ResolveDrive9ExtensionConfigOptions): Promise<ResolvedDrive9ExtensionConfig>;
//# sourceMappingURL=pi-extension-config.d.ts.map