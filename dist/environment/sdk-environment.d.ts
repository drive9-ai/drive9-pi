import type { Context } from "@earendil-works/chord";
import { ExecutionError, type ExecutionEnv, type Result, type ShellExecOptions, type ShellExecResult } from "@earendil-works/pi-durable/env";
import { Drive9DurableFileSystem, type Drive9DurableFileSystemOptions } from "../drive9-durable-file-system.js";
import { type Drive9RuntimeExecClient } from "./runtime-shell.js";
export type Drive9SdkExecutionEnvOptions = Drive9DurableFileSystemOptions & {
    /**
     * The SAME authenticated Drive9 object that backs the filesystem, also
     * exposing Runtime `exec`. Supply it to enable ordinary-root shell execution:
     * a command then addresses the identical namespace as the file tools
     * (`workspace.root = root`, no `layer_id`). Omit to keep shell execution
     * fail-closed (`shell_unavailable`).
     */
    runtime?: Drive9RuntimeExecClient;
};
/**
 * Pi 1.0 environment for agents using the Drive9 SDK directly (ordinary root).
 *
 * The filesystem and the shell share ONE authenticated client and the same
 * ordinary Drive9 root: a command run through `exec` sees files the agent wrote
 * via the filesystem, and vice versa. Without a `runtime` client, shell
 * execution fails closed; commands never fall through to the host process.
 * LayerFS and the coding-agent host-temp bash path are out of scope
 * (see docs/design/runtime-exec-integration.md).
 */
export declare class Drive9SdkExecutionEnv extends Drive9DurableFileSystem implements ExecutionEnv {
    #private;
    constructor(options: Drive9SdkExecutionEnvOptions);
    exec(command: string, options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>>;
}
//# sourceMappingURL=sdk-environment.d.ts.map