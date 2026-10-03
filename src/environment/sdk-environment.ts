import type { Context } from "@earendil-works/chord";
import {
  err,
  ExecutionError,
  type ExecutionEnv,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
} from "@earendil-works/pi-durable/env";
import {
  Drive9DurableFileSystem,
  type Drive9DurableFileSystemOptions,
} from "../drive9-durable-file-system.js";

export type Drive9SdkExecutionEnvOptions = Drive9DurableFileSystemOptions;

/**
 * Pi 1.0 environment for file-only agents using the Drive9 SDK directly.
 *
 * The filesystem and environment share one namespace identity. Shell execution
 * always fails closed; commands never fall through to the host process.
 *
 * This environment remains preview until Drive9 SDK acknowledgement durability
 * is proven against a real backend from another process.
 */
export class Drive9SdkExecutionEnv extends Drive9DurableFileSystem implements ExecutionEnv {
  async exec(
    _command: string,
    _options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (context.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));
    return err(
      new ExecutionError(
        "shell_unavailable",
        "Drive9SdkExecutionEnv provides filesystem access only; shell execution is unavailable",
      ),
    );
  }
}
