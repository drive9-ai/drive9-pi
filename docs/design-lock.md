# Pi × Drive9 P0 Design Lock

Status: **Proposed**  
Implementation must not start until this document is approved.

## 1. Purpose

P0 integrates Pi with Drive9 through two explicit contracts:

1. `Drive9ExecutionEnv`: Pi filesystem and shell operations run against one
   Drive9 FUSE workspace.
2. `ToolResultStore`: large text tool output is durably finalized in Drive9
   before a compact `resultId` is returned to the model.

P0 also ships the minimum adapters needed to close the evidence loop:

- a streaming `drive9_exec` tool;
- an `afterToolCall` fallback for tools that already produced an in-memory
  result;
- bounded `result_read` and `result_search` tools;
- immutable chunk and terminal-manifest conventions;
- optional workspace checkpoint metadata on every result.

P0 does **not** claim that Drive9 currently provides a global transaction over
process side effects, filesystem mutations, journal entries, checkpoints, and
tool results.

## 2. Source Lock

This contract was checked against these exact revisions:

| Project | Revision | Relevant source |
| --- | --- | --- |
| Pi | `9c53c47f8086190d0b433216fcfffae69d3e255f` | `packages/agent/src/harness/types.ts`, `packages/agent/src/types.ts`, `packages/agent/src/agent-loop.ts`, `packages/coding-agent/src/core/agent-session.ts` |
| Drive9 client and TypeScript SDK | `645f5ce8bb14bfcbae801eb90b641c890620db48` | `clients/drive9-js`, `pkg/fuse`, `cmd/drive9` |
| Drive9 server | `d1b3780ae7506e15fa3b5eb86f8d27725e23e844` | `pkg/server/fs_layer.go`, `pkg/datastore/fs_layer.go`, `pkg/journal/journal.go`, `docs/design/layered-filesystem-feature-matrix.md` |

Any incompatible upstream contract change requires updating this document and
the conformance tests before upgrading dependencies.

## 3. Verified Upstream Contracts

### 3.1 Pi

- `ExecutionEnv` is the public `FileSystem & Shell` contract from
  `@earendil-works/pi-agent-core`.
- Every `FileSystem` operation returns `Result<T, FileError>` and must never
  throw or reject.
- `Shell.exec()` returns
  `Result<{ stdout, stderr, exitCode }, ExecutionError>` and may receive
  streaming stdout/stderr callbacks.
- `AgentTool.execute(toolCallId, params, signal?, onUpdate?)` is public.
- `afterToolCall` may replace the complete result fields, but it runs only
  after the original tool has already built its result.
- Pi's current Node shell captures complete stdout and stderr in memory. The
  current Bash tool truncates model-visible output after execution; this is not
  a durable or memory-bounded result store.
- `createCodingAgentHarness({ env })` exists in Pi source but is not exported
  by the public `@earendil-works/pi-coding-agent` package root. Coding-agent
  extensions can register tools and intercept `tool_result`; they cannot
  replace the CLI's global `ExecutionEnv` through a public API.

### 3.2 Drive9

- FUSE, LayerFS, checkpoints, historical checkpoint mounts, layer rollback,
  scoped filesystem credentials, per-file revision CAS, and Journal Phase 1
  exist.
- A LayerFS checkpoint records the maximum durable entry sequence while
  holding the same layer-row lock used by entry upserts. It identifies a
  durable ordering point.
- `drive9 mount --layer L --checkpoint C` restores a checkpoint view.
  `rollbackFSLayer(L)` instead abandons the whole layer; it is not an in-place
  "rewind this active layer to checkpoint C" operation.
- A checkpoint covers durable layer entries. It does not itself flush pending
  FUSE writeback; callers that need a post-write checkpoint must first use a
  real drain/flush barrier.
- The TypeScript SDK supports create-if-absent and revision-gated writes,
  bounded range reads, multipart writes with a known total size, LayerFS, and
  Journal.
- The SDK does not provide an open-ended append writer: `appendStream` first
  materializes the supplied stream, and `StreamWriter` requires total size.
- Journal artifact references are rejected in the current server phase. There
  is no shipped Tool Result Artifact API and no atomic mutation envelope that
  commits a file mutation, journal entry, checkpoint, and result together.

## 4. P0 Truth Matrix

| Claim | P0 status | Exact boundary |
| --- | --- | --- |
| Pi file tools operate on a Drive9 workspace | Supported | Mount-backed and root-confined `ExecutionEnv` |
| Shell output is durable before the model sees `resultId` | Supported for `drive9_exec` | Tool waits for terminal manifest CAS |
| Existing tool output can be offloaded | Supported as fallback | `afterToolCall` runs after memory was already consumed |
| Model result reads are bounded | Supported | Line, byte, match, response, and scan caps |
| Evidence survives LayerFS rollback | Supported | Evidence uses direct base-FS writes outside the overlay protocol |
| Evidence identifies a workspace revision | Supported as provenance metadata | Durable checkpoint/sequence observation, not proof of an isolated process snapshot |
| Every shell side effect is confined to Drive9 | **Not supported** | `cwd` is confined; the process can still access host paths/network without an external sandbox |
| All tools are exactly once | **Not supported** | Result persistence is idempotent; external tool execution is not |
| File mutation + journal + checkpoint + result is atomic | **Not supported** | No current Drive9 server primitive spans these resources |
| Terminal evidence is server-enforced WORM | **Not supported** | P0 uses ordinary Drive9 files and client discipline |
| Interactive Pi CLI globally uses `Drive9ExecutionEnv` | **Not supported by current public API** | Headless agent-core integration is primary; extension support is limited to tools/hooks |
| Full Pi Session Tree × Drive9 Workspace Tree | P1 | P0 records only minimal result-to-workspace bindings |

Documentation and demos must use the wording in this matrix. In particular,
"rollbackable execution" must not be used as a blanket claim for host or
network side effects.

## 5. System Boundaries

### 5.1 Workspace plane

`Drive9ExecutionEnv` operates on a local Drive9 FUSE mount. This is deliberate:
the filesystem seen by Pi tools and the filesystem seen by local shell
processes must be the same namespace. A direct HTTP filesystem adapter plus a
local shell would create two different workspaces.

### 5.2 Evidence plane

`ToolResultStore` uses the Drive9 TypeScript client directly and writes to a
dedicated evidence prefix using a separately scoped credential. It does not
write through the active LayerFS overlay. Layer rollback therefore does not
delete evidence: the current rollback operation changes the LayerFS state and
emits a layer event; it has no mutation path to ordinary base-filesystem objects
created directly under the evidence prefix.

Recommended deployment shape:

```text
Drive9 tenant
├── /projects/<project>/              # base root
│   └── active LayerFS overlay        # mounted as the Pi workspace
└── /.drive9-pi/evidence/v1/          # direct base-FS evidence prefix
```

The evidence root is configurable because a deployment may place the prefix
under a project-owned namespace. The following are startup invariants, not
documentation suggestions:

1. The remote workspace root and remote evidence root are disjoint; neither may
   contain the other.
2. The FUSE mount exposes only the workspace remote root. The evidence prefix
   must not appear anywhere below the local `workspaceRoot`.
3. The workspace credential has no permission on the evidence prefix. The
   evidence credential is scoped to that prefix and is held only by
   `ToolResultStore`.
4. The evidence credential and remote evidence path are not copied into child
   process environment variables, Pi tool arguments, or model-visible output.
5. Configuration fails closed when path overlap or an authorization probe
   violates these invariants.

Result files are written through the base filesystem client, not through the
rollback layer or workspace mount.

### 5.3 Authority boundary

P0 relies on Drive9 tenant and filesystem-prefix authorization plus library
scope checks. The server does not yet enforce result-level ACLs or WORM. The
evidence credential must not be exposed to the model or shell environment.

This protects evidence from normal workspace FileSystem/shell paths and from
the workspace-scoped credential. It is not a sandbox against hostile code that
can read arbitrary host files or acquire an unrelated tenant-owner credential.
Deployments must run with an isolated home/config directory and no ambient
Drive9 owner credential. Strong protection against a hostile host process is a
future sandbox/server-WORM capability, not a P0 claim.

## 6. Contract A: `Drive9ExecutionEnv`

```ts
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";

export interface Drive9ExecutionEnvOptions {
  workspaceRoot: string;              // absolute local FUSE mount path
  cwd?: string;                       // defaults to workspaceRoot
  tempRoot?: string;                  // defaults inside workspaceRoot
  env?: Record<string, string>;       // default child-process environment
}

export class Drive9ExecutionEnv implements ExecutionEnv {
  constructor(options: Drive9ExecutionEnvOptions);
}
```

The class implements the complete upstream `ExecutionEnv` interface rather
than redefining it.

### 6.1 Path rules

1. `workspaceRoot`, `cwd`, and `tempRoot` are absolute at construction.
2. Relative paths resolve against `cwd`.
3. Lexical escape through `..` and absolute paths outside `workspaceRoot` are
   rejected.
4. Read/follow operations resolve the target and reject symlink escape.
5. Create/write operations resolve the nearest existing parent and reject
   symlink escape through that parent.
6. Rename validates the source and destination parent independently; both must
   be inside the root and on the same filesystem.
7. Removing a symlink removes the addressed link, not its target.
8. Temporary files and directories are created under a private per-environment
   directory inside `tempRoot`; OS `/tmp` is not used.
9. `cleanup()` removes only temporary paths owned by this environment and is
   best-effort/non-throwing.

### 6.2 Error mapping

Filesystem failures are converted to Pi `FileError` values:

| Native condition | Pi code |
| --- | --- |
| aborted signal | `aborted` |
| missing path | `not_found` |
| denied path, root escape, symlink escape | `permission_denied` |
| expected directory | `not_directory` |
| addressed directory where file required | `is_directory` |
| invalid path/name/options | `invalid` |
| unsupported operation | `not_supported` |
| all other failures | `unknown` |

No filesystem method may reject, including unexpected backend or callback
failures.

`Shell.exec` rejects an outside-root or invalid `cwd` as `spawn_error`, because
Pi's `ExecutionErrorCode` has no permission-denied variant. Abort, timeout,
spawn, and callback failures map to the corresponding Pi execution codes.

### 6.3 Shell rules

- The selected `cwd` is resolved and symlink-checked before spawn.
- `TMPDIR`, `TMP`, and `TEMP` default to the environment's private Drive9 temp
  directory unless explicitly overridden.
- Full `Shell.exec` stdout/stderr remain required by the Pi contract and are
  therefore not advertised as memory-bounded. High-output work must use
  `drive9_exec`.
- Root confinement is not an OS sandbox. P0 does not prevent a command from
  reading or mutating host absolute paths or using the network.

## 7. Contract B: `ToolResultStore`

### 7.1 Public types

```ts
export type ResultState =
  | "writing"
  | "completed"
  | "failed"
  | "aborted"
  | "unknown";

export interface ToolResultIdentity {
  sessionId: string;
  runId: string;
  toolCallId: string;
  attempt: number;                    // explicit, non-negative
}

export interface WorkspaceRevision {
  layerId: string;
  durableSeq: number;
  snapshotId?: string;
  capturedAt: string;
}

export interface BeginResultInput {
  identity: ToolResultIdentity;
  toolName: string;
  mediaType: "text/plain; charset=utf-8";
  workspaceBefore?: WorkspaceRevision;
}

export interface AppendInput {
  seq: number;                        // explicit, starts at zero
  stream: "stdout" | "stderr" | "tool";
  data: Uint8Array;                   // at most 64 KiB per stored chunk
}

export interface FinalizeInput {
  state: Exclude<ResultState, "writing">;
  exitCode?: number;
  error?: { code: string; message: string };
  workspaceAfter?: WorkspaceRevision;
}

export interface ResultWriter {
  readonly resultId: string;
  append(input: AppendInput): Promise<void>;
  finalize(input: FinalizeInput): Promise<ResultStat>;
}

export interface ToolResultStore {
  begin(input: BeginResultInput): Promise<ResultWriter>;
  stat(resultId: string): Promise<ResultStat>;
  readLines(resultId: string, input: ReadLinesInput): Promise<ReadPage>;
  readRange(resultId: string, input: ReadRangeInput): Promise<ReadPage>;
  search(resultId: string, input: SearchInput): Promise<SearchPage>;
  recover(resultId: string, input: RecoverInput): Promise<ResultStat>;
}
```

All store failures reject with a typed `ResultStoreError` whose stable codes
are `invalid`, `not_found`, `permission_denied`, `conflict`, `limit_exceeded`,
`incomplete`, `corrupt`, `unavailable`, and `aborted`.

### 7.2 Stable identity

`resultId` is derived from a versioned canonical encoding of
`sessionId/runId/toolCallId/attempt` and SHA-256. Raw identifiers are not used
as path segments. `attempt` is part of the identity because retrying an
external tool is not exactly once.

The same identity always produces the same `resultId`. A different identity
must never alias it.

### 7.3 Storage layout

```text
<evidenceRoot>/v1/results/<p0>/<p1>/<resultId>/
├── manifest.json
└── chunks/
    ├── 000000000000.json
    ├── 000000000001.json
    └── ...
```

Each chunk is an immutable envelope containing schema version, sequence,
stream label, payload length, payload SHA-256, and base64 payload. The logical
result body is the concatenation of decoded payloads in sequence order. The
terminal manifest stores total bytes, total lines, per-stream counts, chunk
count, whole-result SHA-256, and a sparse byte/line index.

### 7.4 Write protocol

1. `begin` creates `manifest.json` in `writing` state with
   `expectedRevision=0`.
2. If creation conflicts, the store reads the manifest. It resumes only when
   schema and full identity match and the state is `writing`; matching terminal
   state is returned idempotently; all other cases fail closed.
3. `append(seq, ...)` creates the sequence chunk with `expectedRevision=0`.
4. If chunk creation conflicts, the existing chunk must match sequence, stream,
   length, and SHA-256. Exact match is an idempotent retry; mismatch is a
   conflict.
5. The writer rejects gaps at finalize. It verifies every sequence from zero,
   each chunk hash, total limits, the aggregate digest, and line accounting.
6. `finalize` CAS-replaces the writing manifest using its observed positive
   revision. A lost response is safe: retry reads the terminal manifest and
   succeeds only if the canonical finalize input and aggregate digest match.
7. Terminal manifests and chunks are never changed by the library.
8. A crash before terminal CAS leaves `writing`. Recovery may resume
   deterministic appends/finalize or CAS it to `unknown`. There is no automatic
   timer that guesses whether an external process ran.
9. No terminal-to-terminal or terminal-to-writing transition exists.

This protocol makes evidence persistence idempotent. It does not make process
execution exactly once and it does not prevent a privileged external client
from overwriting ordinary Drive9 files.

### 7.5 P0 hard limits

| Limit | P0 hard ceiling |
| --- | ---: |
| Decoded chunk payload | 64 KiB |
| Chunks per result | 16,384 |
| Decoded bytes per result | 1 GiB |
| `result_read` bytes per call | 64 KiB |
| `result_read` lines per call | 1,000 |
| `result_search` matches per call | 100 |
| Model-visible response from either read tool | 64 KiB |
| Bytes scanned by one search call | 64 MiB |
| `drive9_exec` inline preview | 8 KiB |

Adapters may configure lower limits. Raising a hard ceiling requires a contract
change and new boundary tests.

`result_read` returns a cursor when more data exists. `result_search` is literal
UTF-8 substring search in P0, supports optional case folding, returns bounded
context around each match, and returns a scan cursor when the 64 MiB scan limit
is reached. P0 does not accept untrusted regular expressions.

Corruption, missing chunks, and checksum mismatch fail closed. Read tools never
fall back to injecting the complete result.

## 8. Pi Adapters

### 8.1 `drive9_exec`

`drive9_exec` is a custom `AgentTool`; it is not a renamed claim about Pi's
built-in `bash`.

Execution order:

1. Resolve invocation identity and optional `workspaceBefore`.
2. `begin` the result.
3. Spawn in the root-confined workspace cwd.
4. Split stdout/stderr callbacks into at most 64 KiB chunks, assign monotonic
   sequence numbers in callback-receipt order, and await durable chunk writes
   with bounded backpressure.
5. On process completion, capture optional `workspaceAfter` after the configured
   drain/checkpoint barrier.
6. Finalize as `completed`, `failed`, `aborted`, or `unknown`.
7. Only after successful terminal finalization return compact model content
   containing result ID, state, exit code, byte/line counts, digest, workspace
   binding, and at most 8 KiB preview.

If result finalization fails, the tool returns an error and must not present a
usable result ID as completed evidence.

Backpressure bounds pending upload memory. Abort stops the child process,
awaits/settles in-flight chunk writes, and terminalizes as `aborted` when the
store remains available.

### 8.2 `afterToolCall` fallback

The fallback serializes text tool content only. When serialized content exceeds
50 KiB, it persists/finalizes the existing result and replaces Pi content with
the same compact reference shape used by `drive9_exec`.

This is a context-size and durability fallback, not a memory-safety guarantee:
the original tool already materialized its result before the hook ran. Image
offload is out of P0.

### 8.3 `result_read` and `result_search`

Both are normal Pi tools backed by `ToolResultStore`. Their schemas expose only
bounded parameters and cursors. The integration host supplies the current
session scope; the tools reject cross-scope result IDs even if the caller can
guess one. Drive9 prefix-scoped authorization remains the external enforcement
boundary.

### 8.4 Supported Pi surfaces

- **Primary P0:** a programmatic host built on
  `@earendil-works/pi-agent-core`, where the host explicitly supplies
  `Drive9ExecutionEnv`, `drive9_exec`, result tools, and `afterToolCall`.
- **Secondary P0:** a coding-agent extension may register the result tools and
  fallback hook. It does not claim to replace the coding-agent CLI's global
  `ExecutionEnv` through the current public package API.

## 9. Workspace Binding and Races

`workspaceBefore` and `workspaceAfter` are provenance observations. For a
LayerFS workspace they contain the layer ID, durable sequence, optional
checkpoint ID, and capture time.

Rules:

1. A capture that claims post-write durability must run after a real FUSE drain
   or equivalent writer barrier.
2. Layer entry upsert and checkpoint sequence capture serialize on the layer
   row, so a concurrent durable mutation is ordered either before or after the
   checkpoint. Tests must prove there is no torn or invented sequence.
3. The integration's local mutation mutex prevents its own tools from racing a
   capture, but it is not a distributed lease. External writers may mutate the
   workspace after `workspaceBefore` and before/during execution.
4. Therefore a binding proves "this durable revision was observed"; it does not
   prove the process read an isolated snapshot unless the deployment supplies
   an exclusive workspace lease or runs against a checkpoint mount.
5. Rollback changes/abandons the workspace layer only. It never deletes the
   separate evidence prefix. Reads of old evidence always display its original
   workspace binding.

## 10. Failure Model

| Failure point | Required behavior |
| --- | --- |
| Manifest create response lost | Repeat `begin`; verify identity |
| Chunk write response lost | Repeat same seq; verify envelope digest |
| Process crashes after chunks | Manifest remains `writing`; explicit recovery resumes or marks `unknown` |
| Finalize response lost | Read terminal manifest; exact match is success |
| Different bytes reuse a seq | Fail `conflict`; never overwrite |
| Missing/corrupt chunk | Fail `incomplete`/`corrupt`; never return partial data as complete |
| Store unavailable during execution | Apply bounded backpressure, then stop/fail; never emit a completed reference |
| Abort/timeout | Stop process, settle writes, finalize `aborted` if possible |
| Callback throws | Map to Pi `callback_error`; preserve already written evidence |
| Checkpoint capture fails | Finalize may retain output without an `workspaceAfter`; it must record the capture error and not invent a revision |
| Layer rollback | Evidence remains readable and displays old binding |

## 11. Acceptance Gates

### 11.1 Execution environment conformance

- Every Pi `FileSystem` method returns `Result` and never rejects under normal,
  abort, permission, invalid-path, and unexpected I/O failures.
- Relative, absolute, `..`, symlink, destination-parent, cwd, and temp-root
  boundaries are covered.
- File mutation queue canonicalization cannot make two aliases bypass the root
  guard.
- Shell cwd outside the workspace is rejected before spawn.

### 11.2 Result protocol conformance

- Stable identity and attempt partitioning.
- Concurrent `begin` for the same identity.
- Idempotent same-byte append and rejection of different-byte reuse.
- Chunk and result limit boundaries.
- Gap, duplicate, corruption, and missing-chunk detection.
- Crash after begin, after chunk, before finalize, and after terminal CAS with a
  lost response.
- Idempotent finalize and immutable terminal state.
- Bounded line/byte reads across chunk boundaries.
- Bounded literal search, response truncation, and scan cursor behavior.
- Cross-session read rejection.

### 11.3 Workspace binding conformance

- Concurrent durable mutation and checkpoint capture produce either the prior
  or next durable sequence, never a mixed identity.
- A required drain failure prevents a false post-write revision claim.
- Evidence created for a layer remains after layer rollback and still reports
  the original layer/checkpoint/durable sequence. The test records terminal
  manifest and chunk Drive9 revisions plus SHA-256 values before rollback, then
  proves the same revisions and bytes remain afterward.
- The local workspace path cannot address the evidence prefix, and a direct
  read/write/delete probe using the workspace credential is denied while the
  evidence-scoped client succeeds. Overlapping workspace/evidence roots fail
  startup.

### 11.4 Required end-to-end demo

The P0 demo must use a real Pi agent-core harness, a real Drive9 mount, and a
real Drive9 result prefix:

1. Run a fixture `npm test` that emits output well above Pi's current 50 KiB
   truncation threshold through `drive9_exec`.
2. Prove the terminal manifest and all chunks exist before the tool result
   containing `resultId` is emitted.
3. Prove the model-visible tool result is at most the configured compact limit.
4. Use `result_search` to find a known late failure and `result_read` to fetch a
   bounded surrounding page; neither call may inject the full result.
5. Modify code in a LayerFS workspace, drain, checkpoint, run the test, and bind
   the evidence to that durable revision.
6. Roll back/abandon the layer and prove the workspace view changes while the
   prior result remains readable with its old workspace binding. Compare every
   terminal manifest/chunk revision and SHA-256 before and after rollback; a
   model-level read alone is not sufficient evidence.
7. Kill the demo process after at least one chunk, restart, and prove explicit
   recovery produces either the exact final digest or terminal `unknown`—never
   a false `completed` result.
8. Report output bytes versus model-visible bytes and list any remaining Pi or
   Drive9 integration friction honestly.

If this demo does not pass, P0 is not complete.

## 12. Implementation Sequence

After this design lock is approved, implementation is split into independently
reviewable pull requests:

1. `Drive9ExecutionEnv` plus Pi conformance tests.
2. `ToolResultStore`, manifest/chunk protocol, bounded readers, and crash tests.
3. `drive9_exec`, fallback hook, result tools, and the real end-to-end demo.

P1 may add the complete Pi Session Tree × Drive9 Workspace Tree, UI, distributed
workspace leases, server-enforced artifacts/WORM, server-side content search,
and a true mutation envelope. None of those may be simulated client-side and
advertised as shipped in P0.
