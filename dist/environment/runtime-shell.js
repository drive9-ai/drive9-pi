import { err, ExecutionError, ok, } from "@earendil-works/pi-durable/env";
import { isRuntimeOutcomeUnknown, RuntimeBusyError, RuntimeCanceledError, RuntimeExecutionError, RuntimeNotEnabledError, RuntimeStartError, RuntimeTimeoutError, } from "drive9";
const MAX_TIMEOUT_MS = 2_147_483_647;
/**
 * Convert a Pi `ShellExecOptions.cwd` to a Runtime `cwd` relative to `root`.
 * undefined → env cwd; relative → resolved against env cwd; absolute → as-is.
 * Returns an explicit outcome so the caller can reject escapes vs run-at-root.
 */
function resolveCwd(root, envCwd, cwd) {
    const base = cwd === undefined ? envCwd : cwd;
    const absolute = base.startsWith("/") ? normalizePosix(base) : normalizePosix(joinPosix(envCwd, base));
    const prefix = root.endsWith("/") ? root : `${root}/`;
    if (absolute === root)
        return { kind: "root" };
    if (!absolute.startsWith(prefix))
        return { kind: "escape" };
    return { kind: "subdir", rel: absolute.slice(prefix.length) };
}
function normalizePosix(p) {
    const parts = [];
    for (const seg of p.split("/")) {
        if (seg === "" || seg === ".")
            continue;
        if (seg === "..") {
            parts.pop(); // underflow is a no-op; the prefix check below rejects escapes
            continue;
        }
        parts.push(seg);
    }
    return `/${parts.join("/")}`;
}
function joinPosix(a, b) {
    return `${a.endsWith("/") ? a.slice(0, -1) : a}/${b}`;
}
/** Pi seconds → Runtime integer timeout_ms. Only 1..MAX is legal; never silently clamp. */
function resolveTimeoutMs(timeout) {
    if (timeout === undefined)
        return {}; // no timeout
    if (!Number.isFinite(timeout) || timeout <= 0)
        return { error: true };
    const ms = Math.ceil(timeout * 1000);
    if (ms < 1 || ms > MAX_TIMEOUT_MS)
        return { error: true };
    return { ms };
}
function spillThresholdValid(value) {
    return Number.isSafeInteger(value) && value >= 0;
}
/**
 * Build a Pi `Shell.exec` over the Drive9 Runtime exec client. See
 * docs/design/runtime-exec-integration.md (V1, ordinary SDK root).
 */
export function createDrive9RuntimeExec(options) {
    return async function exec(command, shellOptions, context) {
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
        }
        else {
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
        const request = {
            command, // pass through; SDK wraps as ["/bin/sh","-c",command]. Never self-split.
            workspace: { root: options.root },
            ...(cwd.kind === "subdir" ? { cwd: cwd.rel } : {}),
            ...(shellOptions?.env === undefined ? {} : { env: shellOptions.env }),
            ...("ms" in timeout && timeout.ms !== undefined ? { timeout_ms: timeout.ms } : {}),
        };
        // --- Per-stream UTF-8 decoding + complete raw spill ---
        const stdoutDecoder = new TextDecoder("utf-8");
        const stderrDecoder = new TextDecoder("utf-8");
        let spillPath;
        let seenBytes = 0;
        let seenNewlines = 0;
        let spilling = false;
        const spillPrefix = [];
        const emit = (text) => {
            if (text.length === 0)
                return;
            try {
                shellOptions?.onOutput?.(text, context);
            }
            catch (error) {
                // Streaming-phase callback throw: surfaced as unknown (command may have run).
                throw new CallbackStreamingError(error);
            }
        };
        const ensureSpill = async () => {
            if (spillPath === undefined)
                spillPath = await options.spill.create(context);
            return spillPath;
        };
        const appendSpill = async (bytes) => {
            try {
                const path = await ensureSpill();
                await options.spill.append(path, bytes, context);
            }
            catch (error) {
                throw new SpillWriteError(error);
            }
        };
        const startSpill = async (chunk) => {
            spilling = true;
            for (const prefix of spillPrefix)
                await appendSpill(prefix);
            spillPrefix.length = 0;
            await appendSpill(chunk);
        };
        const onChunk = async (chunk, decoder) => {
            if (spillOpts !== undefined && chunk.byteLength > 0) {
                if (spilling) {
                    await appendSpill(chunk);
                }
                else {
                    seenBytes += chunk.byteLength;
                    for (const byte of chunk) {
                        if (byte === 0x0a)
                            seenNewlines++;
                    }
                    const seenLines = seenNewlines + (chunk[chunk.byteLength - 1] === 0x0a ? 0 : 1);
                    if (seenBytes > spillOpts.afterBytes || seenLines > spillOpts.afterLines) {
                        await startSpill(chunk);
                    }
                    else {
                        // The Runtime SDK currently allocates each frame, but copy here so
                        // the complete prefix remains stable for any conforming client.
                        spillPrefix.push(chunk.slice());
                    }
                }
            }
            emit(decoder.decode(chunk, { stream: true }));
        };
        const execOptions = {
            ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
            onStdout: (chunk) => onChunk(chunk, stdoutDecoder),
            onStderr: (chunk) => onChunk(chunk, stderrDecoder),
        };
        let result;
        let executionFailed = false;
        let executionError;
        try {
            result = await options.client.exec(request, execOptions);
        }
        catch (error) {
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
            }
            catch (error) {
                const cause = error instanceof CallbackStreamingError ? error.cause : error;
                return err(new ExecutionError("callback_error", "onOutput threw during terminal flush", toError(cause)));
            }
        }
        if (executionFailed)
            return err(mapExecError(executionError, spillPath));
        if (result === undefined) {
            return err(new ExecutionError("unknown", "runtime returned no result"));
        }
        return ok(spillPath === undefined ? { exitCode: result.exitCode } : { exitCode: result.exitCode, spillPath });
    };
}
class CallbackStreamingError extends Error {
    cause;
    constructor(cause) {
        super("onOutput threw while streaming");
        this.cause = cause;
        this.name = "CallbackStreamingError";
    }
}
class SpillWriteError extends Error {
    cause;
    constructor(cause) {
        const resolved = toError(cause);
        super(`spill write failed: ${resolved.message}`, { cause: resolved });
        this.name = "SpillWriteError";
        this.cause = resolved;
    }
}
function toError(value) {
    return value instanceof Error ? value : new Error(String(value));
}
/**
 * Exhaustive, fail-closed mapping from SDK errors to Pi `ExecutionError`.
 * `spillPath` is only attached on timeout/aborted (per Pi's ExecutionError.spillPath contract).
 */
function mapExecError(error, spillPath) {
    if (error instanceof SpillWriteError) {
        return new ExecutionError("unknown", error.message, error.cause);
    }
    if (error instanceof CallbackStreamingError) {
        // A streaming onOutput throw was caught by the SDK and surfaced here: unknown.
        return new ExecutionError("unknown", "onOutput threw while streaming; command outcome unknown", toError(error.cause));
    }
    if (error instanceof RuntimeCanceledError) {
        const e = new ExecutionError("aborted", error.message, error);
        if (spillPath !== undefined)
            e.spillPath = spillPath;
        return e;
    }
    if (error instanceof RuntimeTimeoutError) {
        const e = new ExecutionError("timeout", error.message, error);
        if (spillPath !== undefined)
            e.spillPath = spillPath;
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
//# sourceMappingURL=runtime-shell.js.map