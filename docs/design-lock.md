# Pi × Drive9 Design Lock

## 1. Product Boundary

Drive9 provides two capabilities to Pi:

1. a durable SDK-backed workspace filesystem;
2. a durable tool-result evidence store.

Drive9 does not provide compute, a shell, a sandbox, or a process runner.

Pi core defines the relevant capabilities separately:

```ts
interface FileSystem { /* file operations */ }
interface Shell { exec(...): Promise<Result<...>> }
interface ExecutionEnv extends FileSystem, Shell {}
```

This package implements `FileSystem`. A caller may supply its own `Shell` and
compose the two when an application requires a complete `ExecutionEnv`. The
package must never fall back to the host shell, construct a host execution environment,
or register an exec/bash tool when no caller shell is supplied.

## 2. Public Components

### 2.1 `Drive9FileSystem`

`Drive9FileSystem implements FileSystem` over one active Drive9 LayerFS layer.
It uses Drive9 SDK calls, not `node:fs`, a local mount, FUSE, WebDAV, or a local
temporary mirror.

The filesystem has one absolute POSIX `root` and one `cwd` contained by that
root. All addressed paths are normalized and checked against `root` before any
backend call. Expected backend failures are returned as `FileError`; operation
methods do not reject.

### 2.2 `composeExecutionEnv`

`composeExecutionEnv({ fileSystem, shell })` is delegation only. It forwards
all file operations to the supplied `FileSystem` and `exec` to the supplied
`Shell`. It owns no execution implementation and introduces no fallback.

Without a caller-provided `Shell`, applications use `Drive9FileSystem`
directly and must not register shell tools.

### 2.3 `ToolResultStore`

`PersistentToolResultStore` and `Drive9ResultStoreBackend` keep their immutable
chunk plus CAS-terminal-manifest protocol. Tool output is persisted before a
stable result reference is published to the model.

This package exposes bounded `result_read` and `result_search` tools plus an
`afterToolCall` fallback for oversized text results. It does not expose
any command-execution tool.

## 3. LayerFS Semantics

The rollback-capable filesystem path must use LayerFS SDK operations. Generic
`Client.write/read/rename/removeAll` mutate the base filesystem and therefore
must not be used to implement rollback-capable workspace mutations.

The adapter uses these SDK primitives:

- `getFSLayer` to verify the configured layer and root;
- `diffFSLayer(layerId, maxSeq)` to enumerate the effective entry set at one
  durable sequence;
- `getFSLayerEntry` for current overlay lookup;
- `uploadFSLayerFile` for file writes;
- `readFSLayerFile` for overlay file reads;
- `upsertFSLayerEntry` for `mkdir` and `whiteout`;
- base `read/list/stat` only when no effective layer entry shadows the path;
- `checkpointFSLayer` for a durable sequence observation;
- `rollbackFSLayer` to abandon the entire active layer and return to base.

`rollbackFSLayer(layerId)` is not an in-place rewind to a checkpoint. A
checkpoint records a durable sequence and supports a historical read view. The
current API cannot rewind an active layer to arbitrary checkpoint `C` and then
continue writing from that point.

SDK-native writes do not require `drive9 mount drain`: awaiting the SDK
mutation is the writer barrier for that call. Checkpoint capture still does not
create an isolated process snapshot when unrelated writers mutate the same
layer concurrently; callers that require isolation must supply a lease.

Every merged read operation first obtains `getFSLayer(layerId).durable_seq` and
uses that value as `maxSeq` for `diffFSLayer` and overlay object reads. The
operation retries when the layer sequence changes while it is assembling the
view. This anchors the layer half of one operation. The current server does not
expose a global base-directory revision or an atomic merged base/layer view, so
base consistency requires the documented LayerFS rule that the base root is
not mutated while the layer is active. Cross-operation `listDir` plus
`fileInfo` is not a server snapshot and must not be described as one.

## 4. FileSystem Capability Matrix

The package must not claim complete parity while a method is intentionally
unsupported. Unsupported methods return `FileError("not_supported")` before
performing any mutation.

| Capability | Tier | Primitive and behavior | Failure contract | Required discriminating tests |
| --- | --- | --- | --- | --- |
| addressed paths | implemented | POSIX normalize relative to `cwd`; reject root escape before backend calls | `invalid` or `permission_denied` | relative/absolute paths, `..` escape, root mutation |
| read text/binary | implemented | effective layer entry first; whiteout is absent; otherwise base `read` | mapped `FileError` | layer shadows base, whiteout hides base, base fallback |
| write | implemented | `uploadFSLayerFile`; never generic base `write` | mapped `FileError` | new file, base copy-up, aborted-before-call, base remains unchanged |
| mkdir | implemented | `upsertFSLayerEntry(op="mkdir")`; recursive creation is ordered parent-first | mapped `FileError` | existing base parent, nested creation, file collision |
| remove file/empty dir | implemented | one `whiteout` entry after merged emptiness/type checks | mapped `FileError` | base delete, layer delete, non-empty directory unchanged |
| merged stat | client-composed | capture one durable layer seq; effective entry from `diffFSLayer(maxSeq)`; otherwise base `stat`; retry on layer-seq movement | mapped `FileError` | layer shadow, whiteout, delete then recreate, concurrent layer mutation retry |
| merged list | client-composed | capture one durable layer seq; base `list(dir)` plus direct children from `diffFSLayer(maxSeq)`; whiteout removes, layer entry replaces; retry on layer-seq movement; deterministic name sort | mapped `FileError` | whiteout hides base, layer shadows base, delete/recreate, merged deterministic order, concurrent layer mutation retry |
| create temp file/dir | implemented | unique path under configured temp root using layer write/mkdir | mapped `FileError` | collision retry and cleanup owns only created paths |
| canonical path | partial | normalized addressed path for non-symlinks | symlink returns `not_supported` | regular path and explicit symlink rejection |
| append | unsupported | no LayerFS append/CAS primitive; no unbounded read-modify-write fallback | `not_supported`, no writes | call count proves no backend mutation |
| atomic rename | unsupported | current layer rename entry has no SDK merged-read contract for the target; copy plus whiteout is not atomic | `not_supported`, no writes | source and target unchanged |
| recursive remove | unsupported | no recursive LayerFS mutation primitive; adapter must not partially whiteout a tree | `not_supported`, no writes | entire subtree remains visible |

`diffFSLayer` enumerates the whole effective layer. Merged list/stat are therefore
O(total layer entries) per refresh. The adapter has a configured
`maxLayerEntries` bound plus a `viewTimeoutMs` deadline and fails before
merging when either limit is exceeded. A
server-side prefix-filtered, paginated, atomically merged view is a performance
and consistency follow-up, not a hidden property of this adapter.

Pi core session JSONL storage uses append and atomic rename. Until LayerFS
provides those semantics, `Drive9FileSystem` is a workspace adapter and must not
be presented as a Pi session repository backend.

## 5. Shell Boundary

The caller owns `Shell.exec`, CPU, processes, network access, environment
variables, sandboxing, and command lifecycle.

Bare shell filesystem side effects do not pass through `Drive9FileSystem` and
are not automatically recorded in Drive9. A caller that needs arbitrary POSIX
tools to see the same workspace must explicitly provide a mount or a
materialize/diff/sync bridge inside its own runtime. FUSE may be one optional
bridge, but it is not part of this package's core contract.

The package may persist stdout/stderr supplied by a caller tool into
`ToolResultStore`. Persisting output does not make Drive9 the command executor.

## 6. Evidence Contract

Workspace state and evidence use disjoint roots and credentials.

- Workspace credentials must receive an explicit 401/403 when reading,
  writing, or deleting the evidence root.
- Evidence credentials use create-if-absent and revision-gated replacement.
- A result ID is derived from `sessionId/runId/toolCallId/attempt`.
- Result chunks are immutable and sequence-addressed.
- Final manifest replacement is CAS-protected and idempotent.
- `writing`, `completed`, `failed`, `aborted`, and `unknown` remain distinct.
- Bounded result reads never inject the full oversized result into context.
- Workspace rollback never removes immutable evidence.

`afterToolCall` is a fallback after a tool has already materialized its result;
it is not an open-ended streaming writer. Callers with streaming tool output
must write chunks through `ToolResultStore` before publishing the reference.

## 7. Security and Failure Rules

- No built-in shell, host environment inheritance, or implicit local process.
- No FUSE or mount requirement for SDK filesystem operations.
- Path escape is rejected before a client method is called.
- Workspace and evidence roots must be disjoint.
- A missing object is not accepted as proof of authorization denial.
- Backend exceptions are mapped to stable `FileError` or `ResultStoreError`
  codes; expected failures do not reject from `FileSystem` methods.
- Unsupported operations fail before side effects.
- Cleanup is best-effort and removes only temporary paths created by the
  adapter instance.

## 8. Acceptance Gates

A releasable head must prove:

1. the public package exports no Drive9-owned exec tool or execution class;
2. `Drive9FileSystem` makes SDK calls and imports no local filesystem or host
   execution implementation;
3. no-shell usage works, and the compositor calls only the exact caller shell;
4. ordinary generic base writes are never used for layer workspace mutations;
5. base/layer/whiteout merge behavior is discriminating and deterministic;
6. merged reads use one captured layer sequence, retry on layer movement, and
   fail at the configured whole-layer enumeration bound;
7. append, rename, and recursive remove fail without partial mutation;
8. evidence isolation, CAS finalization, crash recovery, and bounded reads
   remain covered;
9. README and demo state the shell and rollback boundaries without implying
   Drive9 supplies compute or arbitrary checkpoint rewind.
