import type { Context } from "@earendil-works/chord";
import {
  err,
  ExecutionError,
  ok,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
} from "@earendil-works/pi-durable/env";
import {
  isRuntimeOutcomeUnknown,
  RuntimeBusyError,
  RuntimeCanceledError,
  RuntimeExecutionError,
  RuntimeNotEnabledError,
  RuntimeStartError,
  RuntimeTimeoutError,
  type ExecOptions,
  type ExecRequest,
  type ExecResult,
} from "drive9";

/**
 * The exact subset of the Drive9 SDK `Client` the shell uses. The shell is
 * constructed from the SAME authenticated object that backs the filesystem, so
 * exec addresses the identical ordinary Drive9 root (construction invariant,
 * not a guessed `id`/baseUrl match).
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
  /** Drive9 absolute root; becomes Runtime `workspace.root`. */
  root: string;
  /** Read the env's live Drive9 cwd for every exec call. */
  currentCwd(): string;
  spill: RuntimeSpillSink;
}

const MAX_TIMEOUT_MS = 2_147_483_647;

type CwdResolution =
  | { kind: "root" } // run at the workspace root (no Runtime cwd field)
  | { kind: "subdir"; rel: string } // root-relative Runtime cwd
  | { kind: "escape" }; // outside root → reject

/**
 * Convert a Pi `ShellExecOptions.cwd` to a Runtime `cwd` relative to `root`.
 * undefined → env cwd; relative → resolved against env cwd; absolute → as-is.
 * Returns an explicit outcome so the caller can reject escapes vs run-at-root.
 */
function resolveCwd(root: string, envCwd: string, cwd: string | undefined): CwdResolution {
  const base = cwd === undefined ? envCwd : cwd;
  const absolute = base.startsWith("/") ? normalizePosix(base) : normalizePosix(joinPosix(envCwd, base));
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (absolute === root) return { kind: "root" };
  if (!absolute.startsWith(prefix)) return { kind: "escape" };
  return { kind: "subdir", rel: absolute.slice(prefix.length) };
}

function normalizePosix(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      parts.pop(); // underflow is a no-op; the prefix check below rejects escapes
      continue;
    }
    parts.push(seg);
  }
  return `/${parts.join("/")}`;
}

function joinPosix(a: string, b: string): string {
  return `${a.endsWith("/") ? a.slice(0, -1) : a}/${b}`;
}

/** Pi seconds → Runtime integer timeout_ms. Only 1..MAX is legal; never silently clamp. */
function resolveTimeoutMs(timeout: number | undefined): { ms?: number } | { error: true } {
  if (timeout === undefined) return {}; // no timeout
  if (!Number.isFinite(timeout) || timeout <= 0) return { error: true };
  const ms = Math.ceil(timeout * 1000);
  if (ms < 1 || ms > MAX_TIMEOUT_MS) return { error: true };
  return { ms };
}

function spillThresholdValid(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Build a Pi `Shell.exec` over the Drive9 Runtime exec client. See
 * docs/design/runtime-exec-integration.md (V1, ordinary SDK root).
 */
export function createDrive9RuntimeExec(options: RuntimeShellOptions) {
  return async function exec(
    command: string,
    shellOptions: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    // Pre-abort: return a clean aborted before any network call.
    if (context.abortSignal?.aborted) {
      return err(new ExecutionError("aborted", "aborted before start"));
    }

    // --- Option validation (all zero-network on failure) ---
    const timeout = resolveTimeoutMs(shellOptions?.timeout);
    if ("error" in timeout) {
      return err(new ExecutionError("timeout", `invalid timeout: ${shellOptions?.timeout}`));
    }
    if (shellOptions?.inheritEnv === true || shellOptions?.inheritEnv === undefined) {
      // Runtime baseline + explicit env only; host process.env is never forwarded.
    } else {
      // false: we cannot guarantee a host-free env (#1022 has no clear-base switch).
      return err(new ExecutionError("spawn_error", "inheritEnv:false is not supported: host-free env cannot be guaranteed"));
    }
    const spillOpts = shellOptions?.spill;
    if (spillOpts !== undefined) {
      if (!spillThresholdValid(spillOpts.afterBytes) || !spillThresholdValid(spillOpts.afterLines)) {
        return err(new ExecutionError("spawn_error", "spill thresholds must be non-negative safe integers"));
      }
    }
    const cwd = resolveCwd(options.root, options.currentCwd(), shellOptions?.cwd);
    if (cwd.kind === "escape") {
      return err(new ExecutionError("spawn_error", "cwd escapes the workspace root"));
    }

    const request: ExecRequest = {
      command, // pass through; SDK wraps as ["/bin/sh","-c",command]. Never self-split.
      workspace: { root: options.root },
      ...(cwd.kind === "subdir" ? { cwd: cwd.rel } : {}),
      ...(shellOptions?.env === undefined ? {} : { env: shellOptions.env }),
      ...("ms" in timeout && timeout.ms !== undefined ? { timeout_ms: timeout.ms } : {}),
    };

    // --- Per-stream UTF-8 decoding + complete raw spill ---
    const stdoutDecoder = new TextDecoder("utf-8");
    const stderrDecoder = new TextDecoder("utf-8");
    let spillPath: string | undefined;
    let seenBytes = 0;
    let seenNewlines = 0;
    let spilling = false;
    const spillPrefix: Uint8Array[] = [];

    const emit = (text: string) => {
      if (text.length === 0) return;
      try {
        shellOptions?.onOutput?.(text, context);
      } catch (error) {
        // Streaming-phase callback throw: surfaced as unknown (command may have run).
        throw new CallbackStreamingError(error);
      }
    };

    const ensureSpill = async (): Promise<string> => {
      if (spillPath === undefined) spillPath = await options.spill.create(context);
      return spillPath;
    };

    const appendSpill = async (bytes: Uint8Array) => {
      try {
        const path = await ensureSpill();
        await options.spill.append(path, bytes, context);
      } catch (error) {
        throw new SpillWriteError(error);
      }
    };

    const startSpill = async (chunk: Uint8Array) => {
      spilling = true;
      for (const prefix of spillPrefix) await appendSpill(prefix);
      spillPrefix.length = 0;
      await appendSpill(chunk);
    };

    const onChunk = async (chunk: Uint8Array, decoder: TextDecoder) => {
      if (spillOpts !== undefined && chunk.byteLength > 0) {
        if (spilling) {
          await appendSpill(chunk);
        } else {
          seenBytes += chunk.byteLength;
          for (const byte of chunk) {
            if (byte === 0x0a) seenNewlines++;
          }
          const seenLines = seenNewlines + (chunk[chunk.byteLength - 1] === 0x0a ? 0 : 1);
          if (seenBytes > spillOpts.afterBytes || seenLines > spillOpts.afterLines) {
            await startSpill(chunk);
          } else {
            // The Runtime SDK currently allocates each frame, but copy here so
            // the complete prefix remains stable for any conforming client.
            spillPrefix.push(chunk.slice());
          }
        }
      }
      emit(decoder.decode(chunk, { stream: true }));
    };

    const execOptions: ExecOptions = {
      ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
      onStdout: (chunk) => onChunk(chunk, stdoutDecoder),
      onStderr: (chunk) => onChunk(chunk, stderrDecoder),
    };

    let result: ExecResult | undefined;
    let executionFailed = false;
    let executionError: unknown;
    try {
      result = await options.client.exec(request, execOptions);
    } catch (error) {
      executionFailed = true;
      executionError = error;
    }

    // A successful exit or RuntimeExecutionError is a server terminal outcome.
    // Flush pending decoder state before publishing that terminal result. Do
    // not flush an outcome-unknown/callback failure as if it were terminal.
    if (!executionFailed || executionError instanceof RuntimeExecutionError) {
      try {
        emit(stdoutDecoder.decode());
        emit(stderrDecoder.decode());
      } catch (error) {
        const cause = error instanceof CallbackStreamingError ? error.cause : error;
        return err(new ExecutionError("callback_error", "onOutput threw during terminal flush", toError(cause)));
      }
    }

    if (executionFailed) return err(mapExecError(executionError, spillPath));
    if (result === undefined) {
      return err(new ExecutionError("unknown", "runtime returned no result"));
    }
    return ok(spillPath === undefined ? { exitCode: result.exitCode } : { exitCode: result.exitCode, spillPath });
  };
}

class CallbackStreamingError extends Error {
  constructor(readonly cause: unknown) {
    super("onOutput threw while streaming");
    this.name = "CallbackStreamingError";
  }
}

class SpillWriteError extends Error {
  readonly cause: Error;

  constructor(cause: unknown) {
    const resolved = toError(cause);
    super(`spill write failed: ${resolved.message}`, { cause: resolved });
    this.name = "SpillWriteError";
    this.cause = resolved;
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Exhaustive, fail-closed mapping from SDK errors to Pi `ExecutionError`.
 * `spillPath` is only attached on timeout/aborted (per Pi's ExecutionError.spillPath contract).
 */
function mapExecError(error: unknown, spillPath: string | undefined): ExecutionError {
  if (error instanceof SpillWriteError) {
    return new ExecutionError("unknown", error.message, error.cause);
  }
  if (error instanceof CallbackStreamingError) {
    // A streaming onOutput throw was caught by the SDK and surfaced here: unknown.
    return new ExecutionError("unknown", "onOutput threw while streaming; command outcome unknown", toError(error.cause));
  }
  if (error instanceof RuntimeCanceledError) {
    const e = new ExecutionError("aborted", error.message, error);
    if (spillPath !== undefined) e.spillPath = spillPath;
    return e;
  }
  if (error instanceof RuntimeTimeoutError) {
    const e = new ExecutionError("timeout", error.message, error);
    if (spillPath !== undefined) e.spillPath = spillPath;
    return e;
  }
  if (error instanceof RuntimeNotEnabledError) {
    return new ExecutionError("shell_unavailable", error.message, error);
  }
  if (error instanceof RuntimeStartError) {
    // Proven not started → safe to classify as spawn_error (adapter never retries).
    return new ExecutionError("spawn_error", error.message, error);
  }
  if (error instanceof RuntimeBusyError) {
    // 429, nothing started; adapter performs zero retries (caller may choose to).
    return new ExecutionError("spawn_error", error.message, error);
  }
  if (isRuntimeOutcomeUnknown(error)) {
    return new ExecutionError("unknown", toError(error).message, toError(error));
  }
  // Any other RuntimeExecutionError / protocol error: the command may have started
  // or produced side effects — never claim spawn-safe.
  return new ExecutionError("unknown", `runtime execution error: ${toError(error).message}`, toError(error));
}
