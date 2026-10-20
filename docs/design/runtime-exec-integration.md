# Drive9 Runtime exec integration

This document locks the V1 contract for adding Drive9 Runtime execution to the
Pi 1.0 SDK execution environment. The target is a single environment where an
agent's file operations and commands address the same persistent Drive9 root.

The contract is grounded in Pi 1.0's `Shell`/`ExecutionEnv` types and the
Drive9 Runtime client introduced by `mem9-ai/drive9#1022`.

## Scope

V1 includes:

- a Runtime-backed `Shell.exec` used by `Drive9SdkExecutionEnv`;
- Pi durable's canonical bash tool, which already calls `ExecutionEnv.exec` and
  supplies output callbacks and spill thresholds; and
- one ordinary Drive9 SDK root shared by file operations and Runtime.

V1 deliberately excludes:

- a LayerFS-backed execution environment. Ordinary SDK file operations do not
  accept a `layer_id`, so passing a layer only to Runtime would create two
  different views. A same-layer file-and-exec environment needs its own API;
- the default Pi coding-agent extension's bash path. Its current output
  accumulator writes large output to host `os.tmpdir()`. Until that surface can
  accept the Drive9 spill contract, process tools remain fail-closed; and
- a persistent tool-result record for full command output. V1's spill is a
  Pi-standard temporary file removed by environment cleanup, not a
  cross-cleanup evidence record.

## Construction and workspace binding

`Drive9SdkExecutionEnv` accepts one object satisfying both the filesystem and
Runtime-exec client contracts. It has no separate Runtime client parameter.
This makes the authentication and namespace identity an API invariant rather
than a comparison of mutable identifiers.

Every command sends:

```ts
workspace: { root: environment.root }
```

No `layer_id` is sent. The environment's public `id` remains Pi's namespace
equality declaration; it is not used as a Runtime binding key.

## Shell option mapping

`command` is passed unchanged as `ExecRequest.command`. It is never parsed or
split locally. The Drive9 SDK owns the `/bin/sh -c` quoting, pipeline, variable,
and redirection boundary. An empty string is a valid shell no-op. NUL input or
a profile without `/bin/sh` follows the Runtime client's actual typed failure
path.

`cwd` is resolved on every call:

- omitted: the environment's current, mutable `cwd`;
- relative: resolved against that current `cwd`;
- absolute: used as supplied.

The resolved path must remain inside `environment.root`; otherwise the adapter
returns `spawn_error` before any Runtime call. In-root paths are converted to a
root-relative Runtime `cwd`; the root itself omits the field.

Pi timeout seconds become `Math.ceil(seconds * 1000)`. Only integer results in
`1..2_147_483_647` are accepted. Zero, negative, non-finite, or over-range
values return `timeout` before any Runtime call. Values are never clamped.

Explicit `env` entries pass through unchanged. `inheritEnv` never copies the
adapter process's `process.env` into the sandbox. Omitted or `true` means the
Runtime profile's baseline plus explicit entries. `false` returns
`spawn_error` before the Runtime call because the current Runtime API cannot
guarantee an empty baseline environment.

Both spill thresholds must satisfy `Number.isSafeInteger(value) && value >= 0`.
Invalid byte or line thresholds return `spawn_error` before the Runtime call.

## Output and spill

The adapter provides two distinct output guarantees:

1. `onOutput(text, context)` receives decoded text in publishable-frame order.
   stdout and stderr use independent streaming UTF-8 decoders so a multibyte
   character split across one stream is not corrupted by an interleaved frame
   from the other stream.
2. Once either spill threshold is exceeded, `spillPath` names a temporary file
   under the same Drive9 environment's `tempRoot`. It contains all raw bytes in
   Runtime arrival order, including the bounded prefix received before the
   threshold was crossed.

The threshold is crossed when total bytes are greater than `afterBytes` or the
number of complete-or-partial combined-output lines is greater than
`afterLines`. Before that point, only the threshold-bounded prefix is retained.
After spill starts, each Runtime output callback awaits the Drive9 append, so
backend backpressure propagates.

The spill is readable through the same environment after `exec` returns and is
removed best-effort by `environment.cleanup()`. It never uses host temporary
storage and is not a `PersistentToolResultStore` record.

If spill creation or append fails, the Runtime frame callback rejects. The
Drive9 SDK attempts cancellation and reports an unknown outcome. The adapter
must not continue callbacks, report success, fall back to host storage, or
pretend the partial spill is complete.

Both decoders are flushed after a known terminal result, including terminal
Runtime execution errors. A consumer callback failure during streaming may
have interrupted a running command and therefore maps to `unknown`. A callback
failure during the post-terminal decoder flush maps to `callback_error`.

## Failure mapping

The adapter performs no automatic retries.

| Drive9/adapter outcome | Pi `ExecutionError` | Started? |
| --- | --- | --- |
| context already aborted before call | `aborted` | no Runtime call |
| `RuntimeCanceledError` | `aborted` | confirmed canceled |
| `RuntimeTimeoutError` | `timeout` | terminal known |
| `RuntimeNotEnabledError` | `shell_unavailable` | no |
| `RuntimeBusyError` | `spawn_error` | no; preserve cause/retry delay |
| `RuntimeStartError` | `spawn_error` | proven not started |
| `RuntimeOutcomeUnknownError` | `unknown` | may have started |
| spill/frame callback failure | `unknown` | may have started; cancel attempted |
| other Runtime/protocol failure | `unknown` | fail closed |
| post-terminal decoder callback failure | `callback_error` | terminal known |

Only `timeout` and `aborted` errors may carry `ExecutionError.spillPath`, which
is the temporary Drive9 output captured before the terminal condition. Unknown,
spawn, callback, and unavailable failures never carry a spill path. An abort
that races after the server may have accepted the request remains `unknown`
unless the SDK returns a confirmed `RuntimeCanceledError`.

## Dependency and release gate

Runtime symbols are absent from published `drive9@0.2.0`. Development may use
an exact source build containing `mem9-ai/drive9#1022`, but a releasable
drive9-pi head must use a maintainer-published SDK version containing that API.
The SDK release-preparation PR does not itself authorize merge or publication.

Before release, all of the following are required:

- clean install, typecheck, tests, and package build against the published SDK;
- a real Runtime-enabled, no-skip test using one SDK client and one ordinary
  root where a filesystem write is visible to a command and a command write is
  visible through the filesystem;
- complete raw spill tests for byte and complete-or-partial line thresholds,
  including prefix bytes and interleaved UTF-8 frames;
- tests proving spill failures reject the Runtime callback, trigger the SDK's
  cancellation/unknown path, and stop later output;
- discriminating tests for live cwd, option validation before network access,
  the full error map, zero retry, callback timing, and error `spillPath` scope;
- verified removal of the unique remote E2E root on pass, skip, and failure;
  and
- the default coding-agent process path remains fail-closed with no host-shell
  or host-temp fallback.
