import type { Context } from "@earendil-works/chord";
import { type ExecutionEnv, type Result, type ShellExecOptions, type ShellExecResult, type ExecutionError } from "@earendil-works/pi-durable/env";
import { Drive9DurableFileSystem, type Drive9DurableFileSystemClient, type Drive9DurableFileSystemOptions } from "../drive9-durable-file-system.js";
import { type Drive9RuntimeExecClient } from "./runtime-shell.js";
/** One authenticated object owns both file access and Runtime execution. */
export interface Drive9SdkExecutionEnvClient extends Drive9DurableFileSystemClient, Drive9RuntimeExecClient {
}
export type Drive9SdkExecutionEnvOptions = Omit<Drive9DurableFileSystemOptions, "client"> & {
    /**
     * The SAME authenticated Drive9 object backs file access and Runtime exec.
     * A command addresses the identical ordinary namespace as the file tools
     * (`workspace.root = root`, no `layer_id`).
     */
    client: Drive9SdkExecutionEnvClient;
};
/**
 * Pi 1.0 environment for agents using the Drive9 SDK directly (ordinary root).
 *
 * The filesystem and the shell share ONE authenticated client and the same
 * ordinary Drive9 root: a command run through `exec` sees files the agent wrote
 * via the filesystem, and vice versa. Commands never fall through to the host.
 * LayerFS and the coding-agent host-temp bash path are out of scope
 * (see docs/design/runtime-exec-integration.md).
 */
export declare class Drive9SdkExecutionEnv extends Drive9DurableFileSystem implements ExecutionEnv {
    #private;
    constructor(options: Drive9SdkExecutionEnvOptions);
    exec(command: string, options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>>;
}
//# sourceMappingURL=sdk-environment.d.ts.map