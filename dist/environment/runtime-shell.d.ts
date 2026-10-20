import type { Context } from "@earendil-works/chord";
import { ExecutionError, type Result, type ShellExecOptions, type ShellExecResult } from "@earendil-works/pi-durable/env";
import { type ExecOptions, type ExecRequest, type ExecResult } from "drive9";
/**
 * The exact subset of the Drive9 SDK `Client` the shell uses. The shell is
 * constructed from the SAME authenticated object that backs the filesystem, so
 * exec addresses the same authenticated Drive9 drive and starts in the
 * configured ordinary root (construction invariant, not a guessed
 * `id`/baseUrl match). `workspace.root` is not a Runtime access boundary; the
 * current server mount exposes the whole drive to the command.
 */
export interface Drive9RuntimeExecClient {
    exec(input: ExecRequest, options?: ExecOptions): Promise<ExecResult>;
}
/** Sink the shell uses to spill the complete raw output into the same Drive9 tempRoot. */
export interface RuntimeSpillSink {
    /** Create a unique temp file under the env's Drive9 tempRoot; returns its Drive9 absolute path. */
    create(context: Context): Promise<string>;
    /** Append raw bytes to the spill file; rejects on backend failure (→ cancel → unknown). */
    append(path: string, bytes: Uint8Array, context: Context): Promise<void>;
}
export interface RuntimeShellOptions {
    client: Drive9RuntimeExecClient;
    /** Drive9 absolute start root; becomes Runtime `workspace.root`, not an ACL. */
    root: string;
    /** Read the env's live Drive9 cwd for every exec call. */
    currentCwd(): string;
    spill: RuntimeSpillSink;
}
/**
 * Build a Pi `Shell.exec` over the Drive9 Runtime exec client. See
 * docs/design/runtime-exec-integration.md (V1, ordinary SDK root).
 */
export declare function createDrive9RuntimeExec(options: RuntimeShellOptions): (command: string, shellOptions: ShellExecOptions | undefined, context: Context) => Promise<Result<ShellExecResult, ExecutionError>>;
//# sourceMappingURL=runtime-shell.d.ts.map