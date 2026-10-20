import type { Context } from "@earendil-works/chord";
import {
  type ExecutionEnv,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type ExecutionError,
} from "@earendil-works/pi-durable/env";
import {
  Drive9DurableFileSystem,
  type Drive9DurableFileSystemClient,
  type Drive9DurableFileSystemOptions,
} from "../drive9-durable-file-system.js";
import {
  createDrive9RuntimeExec,
  type Drive9RuntimeExecClient,
  type RuntimeSpillSink,
} from "./runtime-shell.js";

/** One authenticated object owns both file access and Runtime execution. */
export interface Drive9SdkExecutionEnvClient
  extends Drive9DurableFileSystemClient, Drive9RuntimeExecClient {}

export type Drive9SdkExecutionEnvOptions = Omit<Drive9DurableFileSystemOptions, "client"> & {
  /**
   * The SAME authenticated Drive9 object backs file access and Runtime exec.
   * A command uses the same authenticated drive as the file tools and starts at
   * `root` (`workspace.root = root`, no `layer_id`). Current Runtime mounts the
   * whole drive, so `root` is not an exec access boundary.
   */
  client: Drive9SdkExecutionEnvClient;
};

/**
 * Pi 1.0 environment for agents using the Drive9 SDK directly (ordinary root).
 *
 * The filesystem and the shell share ONE authenticated client and Drive9 drive:
 * a command run through `exec` sees files the agent wrote via the filesystem,
 * and vice versa. Filesystem methods are root-confined, but Runtime currently
 * exposes the whole drive and uses root only as the start directory. Commands
 * never fall through to the host.
 * LayerFS and the coding-agent host-temp bash path are out of scope
 * (see docs/design/runtime-exec-integration.md).
 */
export class Drive9SdkExecutionEnv extends Drive9DurableFileSystem implements ExecutionEnv {
  readonly #exec: ReturnType<typeof createDrive9RuntimeExec>;

  constructor(options: Drive9SdkExecutionEnvOptions) {
    super(options);
    const spill: RuntimeSpillSink = {
      create: async (context) => {
        const created = await this.createTempFile({ prefix: "runtime-exec-", suffix: ".log" }, context);
        if (!created.ok) throw created.error;
        return created.value;
      },
      append: async (path, bytes, context) => {
        const appended = await this.appendFile(path, bytes, context);
        if (!appended.ok) throw appended.error;
      },
    };
    this.#exec = createDrive9RuntimeExec({
      client: options.client,
      root: this.root,
      currentCwd: () => this.cwd,
      spill,
    });
  }

  async exec(
    command: string,
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    return await this.#exec(command, options, context);
  }
}
